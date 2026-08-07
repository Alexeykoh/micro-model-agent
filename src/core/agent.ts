import type { LLMProvider, ContentPart } from "../llm/provider";
import type { ToolExecutor } from "../tools/executor";
import type { PluginManager } from "../modules/plugins/manager";
import type { ContextManager, Message } from "../modules/context/manager";
import type { HallucinationDetector } from "../modules/hallucination/detector";
import type { Logger } from "../logger/app-logger";
import type { AppConfig } from "../config/types";
import type { ToolScope, ToolDefinition } from "../tools/types";
import type { PromptBlock } from "./types";
import type {
  ToolCall,
  ToolEvent,
  AgentPhase,
  LLMResponse,
  AgentResult,
} from "./types";
import type { SessionManager } from "../modules/session/manager";
import { join } from "path";
import { t } from "../i18n/index";
import { pc } from "../ui/colors";
import { PromptBuilder } from "./prompt-builder";
import { processRegistry } from "../modules/processes";
import { SessionLogger } from "./session-logger";
import { runWithMoE } from "./agent-moe";
import { MemoryStore } from "../modules/memory/store";
import { StepVerifier } from "../modules/execution/verifier";

const TOOL_RESULT_MAX_TOKENS_RATIO = 0.3;
const TOOL_RESULT_ABSOLUTE_MAX_CHARS = 15000;
const QUALITY_TRIGGER_THRESHOLD = 40;

/** True when the text looks like a raw JSON tool payload (garbage to display). */
function isToolCallJson(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export interface AgentDeps {
  config: AppConfig;
  llmProvider: LLMProvider;
  toolExecutor: ToolExecutor;
  pluginManager: PluginManager;
  contextManager: ContextManager;
  hallucinationDetector: HallucinationDetector;
  logger: Logger;
  baseDir: string;
  scope?: ToolScope;
  toolTags?: string[];
  promptBlocks: PromptBlock[];
  getDynamicPromptBlocks?: () => PromptBlock[];
  finalAudit?: () => Promise<{
    passed: boolean;
    done: number;
    total: number;
    pendingSteps: string[];
    missingFiles: string[];
    summary: string;
  } | null>;
  sessionManager?: SessionManager;
  exitOnComplete?: boolean;
}

export class Agent {
  private deps: AgentDeps;
  private systemPromptAdded = false;
  private shutdownRequested = false;
  private abortController: AbortController | null = null;

  constructor(deps: AgentDeps) {
    this.deps = deps;
  }

  /** Expose context manager for REPL image attachment and other direct access. */
  get contextManager(): ContextManager {
    return this.deps.contextManager;
  }

  private setScope(): void {
    if (this.deps.scope) {
      this.deps.toolExecutor.setScope(this.deps.scope);
    }
  }

  private buildSystemPrompt(): { prompt: string; excluded: string[] } {
    const systemBudget = Math.floor(
      this.deps.config.contextWindow *
        this.deps.config.contextBudget.systemPrompt,
    );
    const builder = new PromptBuilder(systemBudget);
    builder.addBlocks(this.deps.promptBlocks);
    const dynamic = this.deps.getDynamicPromptBlocks?.() ?? [];
    if (dynamic.length > 0) {
      builder.addBlocks(dynamic);
    }
    const pluginBlocks: PromptBlock[] = (
      this.deps.pluginManager.runOnBuildPrompt?.() ?? []
    )
      .filter((s): s is string => Boolean(s && s.trim() !== ""))
      .map((content) => ({
        content,
        priority: "low" as const,
        essential: false,
        estimatedTokens: this.deps.llmProvider.countTokens(content),
      }));
    if (pluginBlocks.length > 0) {
      builder.addBlocks(pluginBlocks);
    }
    return builder.build();
  }

  getSystemPromptInfo(): {
    text: string;
    tokenCount: number;
    excluded: string[];
  } {
    const { prompt, excluded } = this.buildSystemPrompt();
    const tokenCount = this.deps.llmProvider.countTokens(prompt);
    return { text: prompt, tokenCount, excluded };
  }

  private refreshSystemPrompt(): void {
    const { prompt } = this.buildSystemPrompt();
    const current = this.deps.contextManager
      .getActiveHistory()
      .find((m) => m.role === "system");
    if (!current || current.content !== prompt) {
      this.deps.contextManager.updateSystemPrompt?.(prompt);
    }
  }

  private truncateToolOutput(
    output: string,
    budget: { history: number },
    currentTokens: number,
  ): string {
    const remainingBudget = budget.history - currentTokens;
    const maxCharsByBudget = Math.floor(remainingBudget * 0.5 * 2);
    const maxCharsByRatio = Math.floor(
      budget.history * TOOL_RESULT_MAX_TOKENS_RATIO * 2,
    );
    const maxChars = Math.min(
      maxCharsByBudget,
      maxCharsByRatio,
      TOOL_RESULT_ABSOLUTE_MAX_CHARS,
    );

    if (output.length <= maxChars) return output;

    const truncated = output.slice(0, maxChars);
    const removedChars = output.length - maxChars;
    return (
      truncated +
      `\n\n${t("tool.truncated", { tokens: Math.ceil(removedChars / 2) })}`
    );
  }

  private emitPhase(
    iteration: number,
    phase: AgentPhase,
    onPhase?: (phase: AgentPhase) => void,
  ): void {
    this.deps.pluginManager.runOnPhase?.(
      { iteration, logger: this.deps.logger },
      phase,
    );
    onPhase?.(phase);
  }

  async run(
    input: string,
    onChunk?: (chunk: string) => void,
    onMeta?: (meta: string) => void,
    onTool?: (ev: ToolEvent) => void,
    onPhase?: (phase: AgentPhase) => void,
  ): Promise<AgentResult> {
    this.setScope();
    const {
      config,
      llmProvider,
      toolExecutor,
      pluginManager,
      contextManager,
      logger,
      sessionManager,
      baseDir,
    } = this.deps;

    const slog = new SessionLogger(sessionManager);

    if (sessionManager && !sessionManager.getActive()) {
      sessionManager.create();
      logger.debug(`Session started: ${sessionManager.getActive()}`);
    }

    if (
      !this.systemPromptAdded &&
      !contextManager.getActiveHistory().some((m) => m.role === "system")
    ) {
      const { prompt: systemPrompt, excluded } = this.buildSystemPrompt();
      contextManager.addMessage({ role: "system", content: systemPrompt });
      this.systemPromptAdded = true;
      slog.logSystem(systemPrompt.slice(0, 2000));
      if (excluded.length > 0) {
        slog.logSystem(`[Excluded prompt blocks: ${excluded.length}]`);
      }
      pluginManager.runOnSessionStart({
        logger,
        sessionManager: sessionManager?.getActiveMeta(),
      });

      if (config.session?.baselineCheck !== false) {
        const verifier = new StepVerifier(baseDir);
        verifier
          .runTypeCheck()
          .then((tc) => {
            if (!tc.passed) {
              logger.warn(
                `Baseline typecheck has issues: ${tc.message?.slice(0, 500)}`,
              );
              onMeta?.(pc.yellow(`\n⚠ Baseline typecheck has issues\n`));
            }
          })
          .catch(() => {});
      }
    }

    contextManager.addMessage({ role: "user", content: input });
    slog.logUser(input);

    if (config.moe?.enabled) {
      return runWithMoE(
        {
          config,
          llmProvider,
          toolExecutor,
          logger,
          baseDir: this.deps.baseDir,
        },
        input,
        () =>
          this.executeSingleAgentLoop(input, onChunk, onMeta, onTool, onPhase),
        { onMeta, onTool, onPhase },
      );
    }

    return this.executeSingleAgentLoop(input, onChunk, onMeta, onTool, onPhase);
  }

  private async executeSingleAgentLoop(
    input: string,
    onChunk?: (chunk: string) => void,
    onMeta?: (meta: string) => void,
    onTool?: (ev: ToolEvent) => void,
    onPhase?: (phase: AgentPhase) => void,
  ): Promise<AgentResult> {
    const {
      config,
      llmProvider,
      toolExecutor,
      pluginManager,
      contextManager,
      hallucinationDetector,
      logger,
      sessionManager,
      baseDir,
    } = this.deps;

    const slog = new SessionLogger(sessionManager);
    this.abortController = new AbortController();
    let iteration = 0;
    let lastText = "";
    let hallucinationRetries = 0;
    let lastToolSignature = "";
    let apiPromptTokens = 0;
    let apiCompletionTokens = 0;
    const MAX_HALLUCINATION_RETRIES = 3;
    let consecutiveToolFailures = 0;
    const MAX_CONSECUTIVE_TOOL_FAILURES = 5;
    let auditRetries = 0;
    const MAX_AUDIT_RETRIES = 3;

    while (iteration < config.maxToolIterations && !this.shutdownRequested) {
      iteration++;
      contextManager.noteIteration();

      pluginManager.runOnBeforeThink({
        iteration,
        logger,
        lastUserMessage: input,
        contextManager,
        onMeta,
        sessionLog: {
          plan: (event: string, detail: string, iter?: number) =>
            slog.logPlan(event, detail, iter),
        },
      });

      if (contextManager.needsCompaction()) {
        contextManager.compact();
        logger.debug("Context compacted");
        slog.logCompaction(
          `regular compaction, iteration ${iteration}`,
          iteration,
        );
      }

      const currentTokens = contextManager.getEstimatedTokens();
      const budget = contextManager.getBudget();
      const quality = contextManager.getQuality();
      if (
        quality < QUALITY_TRIGGER_THRESHOLD &&
        contextManager.getCompactionCount() > 0
      ) {
        contextManager.compact();
        logger.warn(
          `Low context quality (${quality}%) — forced compaction`,
        );
        slog.logCompaction(
          `quality-triggered compaction (${quality}% < ${QUALITY_TRIGGER_THRESHOLD}%), iteration ${iteration}`,
          iteration,
          currentTokens,
          budget.history,
        );
      }
      if (currentTokens > budget.history) {
        contextManager.compact();
        logger.warn(
          `Context overflow (${currentTokens} > ${budget.history}), forced compaction`,
        );
        slog.logCompaction(
          `forced compaction (${currentTokens} > ${budget.history}), iteration ${iteration}`,
          iteration,
          currentTokens,
          budget.history,
        );
      }

      this.refreshSystemPrompt();
      const history = contextManager.getActiveHistory();

      const allTools = toolExecutor.getToolDefinitions(this.deps.toolTags);
      slog.logToolDefs(
        allTools.length,
        allTools.map((t) => t.name),
        iteration,
      );

      let textContent = "";
      let reasoningContent = "";
      const toolCalls: ToolCall[] = [];
      let sawToolCall = false;
      let emittedReasoning = false;
      const textChunks: string[] = [];

      this.emitPhase(iteration, "thinking", onPhase);
      try {
        for await (const chunk of llmProvider.chat(
          history,
          allTools as ToolDefinition[],
          this.abortController?.signal,
        )) {
          if (this.shutdownRequested) break;
          if (chunk.type === "text" && chunk.content) {
            if (emittedReasoning && !textContent) {
              onMeta?.("\n\n");
            }
            textContent += chunk.content;
            textChunks.push(chunk.content);
          }
          if (chunk.type === "reasoning" && chunk.content) {
            reasoningContent += chunk.content;
            if (config.showReasoning) {
              const metaOut = pluginManager.runOnMeta(
                { iteration, logger },
                chunk.content,
              );
              if (metaOut) {
                onMeta?.(pc.dim(metaOut));
              }
              emittedReasoning = true;
            }
          }
          if (chunk.type === "tool_call" && chunk.toolCall) {
            sawToolCall = true;
            let parsedArgs: Record<string, unknown>;
            try {
              parsedArgs = JSON.parse(chunk.toolCall.arguments);
            } catch {
              parsedArgs = {};
            }
            toolCalls.push({
              id: chunk.toolCall.id,
              name: chunk.toolCall.name,
              arguments: parsedArgs,
            });
          }
          if (chunk.type === "done" && chunk.usage) {
            apiPromptTokens += chunk.usage.promptTokens;
            apiCompletionTokens += chunk.usage.completionTokens;
          }
        }
      } catch (err: any) {
        if (this.shutdownRequested || err?.name === "AbortError") {
          logger.info("LLM call aborted (interrupt)");
          break;
        }
        logger.error(`LLM call failed: ${err.message}`);
        slog.logError(err.message);
        pluginManager.runOnError({ iteration, logger }, err);
        return {
          success: false,
          text: lastText,
          error: t("error.llm", { message: err.message }),
          iterationCount: iteration,
        };
      } finally {
        this.emitPhase(iteration, "done", onPhase);
      }

      if (this.shutdownRequested) {
        break;
      }

      // Show the model's commentary text. When a tool call accompanies the
      // response, keep the text too (opencode-like narration), unless it is
      // a raw JSON payload that small models sometimes emit instead of
      // describing the call. `toolComments: false` restores the old behavior
      // of suppressing text next to a tool call.
      const toolComments = this.deps.config.ui?.toolComments ?? true;
      const showText =
        textChunks.length > 0 &&
        (!sawToolCall || (toolComments && !isToolCallJson(textContent)));
      if (showText) {
        for (const chunk of textChunks) {
          const textOut = pluginManager.runOnText({ iteration, logger }, chunk);
          onChunk?.(textOut);
        }
      }

      let llmResponse: LLMResponse | null = null;
      if (sawToolCall) {
        llmResponse = { type: "tool_call", calls: toolCalls };
      } else if (textContent) {
        llmResponse = { type: "text", content: textContent };
      } else if (reasoningContent) {
        llmResponse = { type: "reasoning", content: reasoningContent };
      }
      pluginManager.runOnAfterThink({ iteration, logger }, llmResponse);

      if (this.deps.exitOnComplete && sawToolCall) {
        const signature = toolCalls
          .map((tc) => `${tc.name}:${JSON.stringify(tc.arguments)}`)
          .join("|");
        if (signature && signature === lastToolSignature) {
          logger.debug(
            "Exit-on-complete: repeated identical tool call, stopping",
          );
          break;
        }
        lastToolSignature = signature;
      }

      if (sawToolCall) {
        slog.logAssistant(
          textContent || "",
          reasoningContent,
          toolCalls,
          iteration,
        );
      }

      if (sawToolCall) {
        contextManager.addMessage({
          role: "assistant",
          content: textContent || "",
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        });
        const summaries: string[] = [];
        let anyToolFailed = false;
        for (const call of toolCalls) {
          this.setScope();
          const startTime = Date.now();
          pluginManager.runOnToolCall({
            toolName: call.name,
            args: call.arguments,
          });
          pluginManager.runOnToolStart(
            { iteration, logger },
            { id: call.id, name: call.name, arguments: call.arguments },
          );
          onTool?.({ type: "start", tool: call.name, args: call.arguments });
          slog.logToolCall(call, iteration);

          const tokensBeforeTool = contextManager.getEstimatedTokens();
          const result = await toolExecutor.execute(
            call,
            this.abortController?.signal,
          );
          const duration = Date.now() - startTime;
          if (!result.success) anyToolFailed = true;

          if (result.success && call.arguments.path) {
            const filePath = String(call.arguments.path);
            if (call.name === "write_file" || call.name === "edit_file") {
              hallucinationDetector
                .getConsistencyCheck()
                .trackCreatedFile(filePath);
            } else if (call.name === "delete_file") {
              hallucinationDetector
                .getConsistencyCheck()
                .trackDeletedFile(filePath);
            }
          }

          pluginManager.runOnToolEnd(
            { iteration, logger },
            { id: call.id, name: call.name, arguments: call.arguments },
            result,
            duration,
          );
          if (result.display) {
            onMeta?.("\n" + result.display + "\n");
          } else {
            const metaOut = pluginManager.runOnMeta(
              { iteration, logger },
              result.output,
            );
            onMeta?.("\n" + pc.dim(metaOut) + "\n");
          }
          if (result.diff) {
            onMeta?.("\n" + result.diff + "\n");
          }

          const currentTokens = contextManager.getEstimatedTokens();
          const budget = contextManager.getBudget();
          const truncatedOutput = this.truncateToolOutput(
            result.output,
            budget,
            currentTokens,
          );
          contextManager.addMessage({
            role: "tool",
            content: truncatedOutput,
            name: call.name,
            tool_call_id: call.id,
            success: result.success,
            arguments: call.arguments,
          });

          const tokensAfterTool = contextManager.getEstimatedTokens();
          onTool?.({
            type: "end",
            tool: call.name,
            args: call.arguments,
            duration,
            error: !result.success,
            ctxDelta: tokensAfterTool - tokensBeforeTool,
          });

          summaries.push(
            `[Tool: ${call.name} (${JSON.stringify(call.arguments)}) → ${truncatedOutput.slice(0, 200)}]`,
          );

          if (config.session.autoSave) {
            slog.logToolResult(call, result, duration, iteration);
          }
          if (contextManager.needsCompaction()) {
            contextManager.compact();
            logger.debug("Context compacted after tool result");
          }
        }
        if (anyToolFailed) {
          consecutiveToolFailures++;
        } else {
          consecutiveToolFailures = 0;
        }
        if (consecutiveToolFailures >= MAX_CONSECUTIVE_TOOL_FAILURES) {
          const recoveryMsg = t("exec.consecutive_failures_recovery", {
            count: consecutiveToolFailures,
          });
          logger.warn(`Consecutive tool failures: ${consecutiveToolFailures}`);
          const taskSnippet =
            input.length > 200 ? input.slice(0, 200) + "..." : input;
          const taskReminder = t("exec.task_reminder", { task: taskSnippet });
          contextManager.addMessage({
            role: "user",
            content: `<system-summary>${recoveryMsg}\n${taskReminder}</system-summary>`,
          });

          if (sessionManager) {
            const activeSession = sessionManager.getActiveMeta();
            if (activeSession) {
              const memDir = join(baseDir, ".mma", "memory");
              const memStore = new MemoryStore(memDir);
              memStore.appendRule(
                "errors",
                `${consecutiveToolFailures} consecutive tool failures`,
                "Multiple tools failing suggests environment or configuration issue",
                "Check dependencies, verify file paths, try write_file directly instead of shell commands",
              );
            }
          }
        }
        contextManager.addMessage({
          role: "user",
          content: `<system-summary>${summaries.join("\n")}</system-summary>`,
        });

        const ctxTokens = contextManager.getEstimatedTokens();
        const ctxBudget = contextManager.getBudget();
        const ctxPct = Math.min(
          100,
          Math.round((ctxTokens / ctxBudget.history) * 100),
        );
        const barLen = 10;
        const filled = Math.round((ctxPct / 100) * barLen);
        const ctxBar =
          pc.green("█".repeat(filled)) + pc.dim("░".repeat(barLen - filled));
        const pctColor = ctxPct >= 75 ? pc.yellow : pc.dim;
        const compCount = contextManager.getCompactionCount();
        const quality = contextManager.getQuality();
        const qualityColor =
          quality >= 70 ? pc.green : quality >= 40 ? pc.yellow : pc.red;
        onMeta?.(
          `\n  ${ctxBar}  ${pctColor(`${ctxPct}%`)}  ${pc.dim(`ctx: ${ctxTokens}/${ctxBudget.history}`)}  ${pc.dim(`compactions: ${compCount}`)}  ${qualityColor(`quality: ${quality}%`)}\n`,
        );

        continue;
      }

      hallucinationDetector
        .getConfidenceCheck()
        .setPreviousResponse(lastText);
      const hallucinationResult = await hallucinationDetector.validate(
        textContent,
      );
      if (hallucinationResult.status === "block") {
        logger.warn(`Response blocked: ${hallucinationResult.reason}`);
        return {
          success: false,
          text: lastText,
          error: t("error.response_blocked", {
            reason: hallucinationResult.reason || "",
          }),
          iterationCount: iteration,
        };
      }
      if (hallucinationResult.status === "warn") {
        logger.warn(`Hallucination warning: ${hallucinationResult.reason}`);
        const warnPrefix = t("hall.uncertainty_prefix");
        if (onChunk) {
          onChunk(warnPrefix);
        }
        lastText = warnPrefix + lastText;
      }
      if (hallucinationResult.status === "retry") {
        if (this.deps.exitOnComplete) {
          logger.debug("Exit-on-complete: stopping on first response");
          break;
        }
        if (hallucinationRetries >= MAX_HALLUCINATION_RETRIES) {
          logger.warn(
            `Hallucination retries exhausted (${MAX_HALLUCINATION_RETRIES}), returning error`,
          );
          return {
            success: false,
            text: lastText,
            error: t("error.response_blocked", {
              reason: t("hall.max_retries_exhausted"),
            }),
            iterationCount: iteration,
          };
        }
        hallucinationRetries++;
        logger.warn(
          `Hallucination retry (${hallucinationRetries}/${MAX_HALLUCINATION_RETRIES}): ${hallucinationResult.reason}`,
        );
        if (textContent) {
          contextManager.addMessage({
            role: "assistant",
            content: textContent,
          });
        }
        contextManager.addMessage({
          role: "user",
          content: `<system-summary>[Retry context: ${hallucinationResult.reason}. Original task: "${input}". You must either call a needed tool or provide a substantive response. Empty replies are not allowed.]</system-summary>`,
        });
        continue;
      }

      if (textContent) {
        contextManager.addMessage({ role: "assistant", content: textContent });
        slog.saveAssistantMessage(textContent);
        slog.logAssistant(textContent, reasoningContent, undefined, iteration);
      }

      lastText = textContent;

      {
        const decisionPatterns = [
          ...textContent.matchAll(
            /(?:plan|decided|decision|решено|план|решение):\s*(.+?)(?:\n|$)/gi,
          ),
        ];
        for (const match of decisionPatterns) {
          hallucinationDetector
            .getConsistencyCheck()
            .trackDecision(match[1].trim(), "agent_response");
        }
      }

      if (!sawToolCall) {
        if (this.deps.finalAudit) {
          const audit = await this.deps.finalAudit();
          if (audit && !audit.passed) {
            logger.warn(`Final audit incomplete: ${audit.summary}`);
            const steps = audit.pendingSteps.slice(0, 5).join("; ") || "—";
            contextManager.addMessage({
              role: "user",
              content: `<system-summary>${t("exec.audit_incomplete", {
                summary: audit.summary,
                steps,
              })}</system-summary>`,
            });
            slog.logAudit(audit.summary, iteration);
            auditRetries++;
            if (
              auditRetries >= MAX_AUDIT_RETRIES ||
              iteration >= config.maxToolIterations - 1
            ) {
              logger.warn(
                `Final audit still incomplete after ${auditRetries} retries — finishing anyway`,
              );
              break;
            }
            continue;
          }
        }
        break;
      }
    }

    const tokensUsed = contextManager.getEstimatedTokens();
    const budget = contextManager.getBudget();

    if (iteration >= config.maxToolIterations) {
      return {
        success: false,
        text: lastText,
        error: t("error.max_iters", { max: config.maxToolIterations }),
        iterationCount: iteration,
        contextUsed: tokensUsed,
        contextLimit: budget.history,
        promptTokens: apiPromptTokens,
        completionTokens: apiCompletionTokens,
        totalTokens: apiPromptTokens + apiCompletionTokens,
        compactionCount: contextManager.getCompactionCount(),
        contextQuality: contextManager.getQuality(),
      };
    }

    return {
      success: true,
      text: lastText,
      iterationCount: iteration,
      contextUsed: tokensUsed,
      contextLimit: budget.history,
      promptTokens: apiPromptTokens,
      completionTokens: apiCompletionTokens,
      totalTokens: apiPromptTokens + apiCompletionTokens,
      compactionCount: contextManager.getCompactionCount(),
      contextQuality: contextManager.getQuality(),
    };
  }

  clearContext(): void {
    this.deps.contextManager.clear();
    this.systemPromptAdded = false;
  }

  async reconfigure(config: AppConfig): Promise<void> {
    const { OpenAICompatProvider } = await import("../llm/openai-compat");
    const { TokenCounter } = await import("../llm/token-counter");
    const newProvider = new OpenAICompatProvider({
      model: config.model,
      baseUrl: config.provider.baseUrl,
      apiKey: config.provider.apiKey,
      contextWindow: config.contextWindow,
      retry: config.retry,
      rateLimits: config.security?.rateLimits,
    });
    this.deps.llmProvider = newProvider;
    this.deps.toolExecutor.updateProvider(newProvider);
    const newTokenCounter = new TokenCounter(config.model);
    this.deps.contextManager.resize(
      config.contextWindow,
      config.contextBudget,
      newTokenCounter,
    );
    this.deps.config = config;
  }

  setContext(
    messages: Array<{
      role: string;
      content: string | ContentPart[];
      name?: string;
    }>,
  ): void {
    const { contextManager } = this.deps;
    contextManager.clear();
    const { prompt: systemPrompt } = this.buildSystemPrompt();
    contextManager.addMessage({ role: "system", content: systemPrompt });
    this.systemPromptAdded = true;
    for (const msg of messages) {
      if (msg.role === "system") continue;
      contextManager.addMessage({
        role: msg.role as Message["role"],
        content: msg.content,
        name: msg.name,
      });
    }
  }

  shutdown(): void {
    this.shutdownRequested = true;
    this.abortController?.abort();
    const { pluginManager, logger, sessionManager, contextManager } = this.deps;
    contextManager.onCompact = null;
    const killed = processRegistry.killAll();
    if (killed > 0) {
      logger.info(`Killed ${killed} background process(es) on shutdown`);
    }
    pluginManager.runOnSessionEnd({
      logger,
      sessionManager: sessionManager?.getActiveMeta(),
    });
  }
}
