import type { LLMProvider, ContentPart } from "../llm/provider";
import type { ToolExecutor } from "../tools/executor";
import type { PluginManager } from "../modules/plugins/manager";
import type { ContextManager, Message } from "../modules/context/manager";
import type { HallucinationDetector } from "../modules/hallucination/detector";
import type { Logger } from "../logger/app-logger";
import type { AppConfig } from "../config/types";
import type { ToolScope, ToolDefinition } from "../tools/types";
import type { PromptBlock } from "./types";
import type { ToolCall, ToolEvent, AgentPhase, LLMResponse, AgentResult } from "./types";
import type { SessionManager } from "../modules/session/manager";
import { t } from "../i18n/index";
import { pc } from "../ui/colors";
import { PromptBuilder } from "./prompt-builder";
import { processRegistry } from "../modules/processes";
import { SessionLogger } from "./session-logger";
import { runWithMoE } from "./agent-moe";

const TOOL_RESULT_MAX_TOKENS_RATIO = 0.3;
const TOOL_RESULT_ABSOLUTE_MAX_CHARS = 15000;

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
    this.deps.pluginManager.runOnPhase?.({ iteration, logger: this.deps.logger }, phase);
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
        () => this.executeSingleAgentLoop(input, onChunk, onMeta, onTool, onPhase),
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
    } = this.deps;

    const slog = new SessionLogger(sessionManager);
    let iteration = 0;
    let lastText = "";
    let hallucinationRetries = 0;
    let lastToolSignature = "";
    let apiPromptTokens = 0;
    let apiCompletionTokens = 0;
    const MAX_HALLUCINATION_RETRIES = 3;
    let consecutiveToolFailures = 0;
    const MAX_CONSECUTIVE_TOOL_FAILURES = 5;

    while (iteration < config.maxToolIterations && !this.shutdownRequested) {
      iteration++;

      pluginManager.runOnBeforeThink({
        iteration,
        logger,
        lastUserMessage: input,
        contextManager,
        onMeta,
      });

      if (contextManager.needsCompaction()) {
        contextManager.compact();
        logger.debug("Context compacted");
        slog.logCompaction(`regular compaction, iteration ${iteration}`, iteration);
      }

      const currentTokens = contextManager.getEstimatedTokens();
      const budget = contextManager.getBudget();
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
      slog.logToolDefs(allTools.length, allTools.map((t) => t.name), iteration);

      let textContent = "";
      let reasoningContent = "";
      const toolCalls: ToolCall[] = [];
      let sawToolCall = false;
      let emittedReasoning = false;
      const textChunks: string[] = [];

      this.emitPhase(iteration, "thinking", onPhase);
      try {
        for await (const chunk of llmProvider.chat(history, allTools as ToolDefinition[])) {
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

      // Display buffered text only if no tool call in this response.
      // When a tool call is present, text is just the model describing
      // its tool call (e.g. raw JSON args) — suppress it.
      if (!sawToolCall && textChunks.length > 0) {
        for (const chunk of textChunks) {
          const textOut = pluginManager.runOnText(
            { iteration, logger },
            chunk,
          );
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
        slog.logAssistant(textContent || "", reasoningContent, toolCalls, iteration);
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

          const result = await toolExecutor.execute(call);
          const duration = Date.now() - startTime;
          if (!result.success) anyToolFailed = true;

          pluginManager.runOnToolEnd(
            { iteration, logger },
            { id: call.id, name: call.name, arguments: call.arguments },
            result,
            duration,
          );
          if (result.display) {
            onMeta?.("\n" + result.display + "\n");
          }
          const metaOut = pluginManager.runOnMeta(
            { iteration, logger },
            result.output,
          );
          onMeta?.("\n" + pc.dim(metaOut) + "\n");
          if (result.diff) {
            onMeta?.("\n" + result.diff + "\n");
          }
          onTool?.({
            type: "end",
            tool: call.name,
            args: call.arguments,
            duration,
            error: !result.success,
          });

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
          const recoveryMsg = t("exec.consecutive_failures_recovery", { count: consecutiveToolFailures });
          logger.warn(`Consecutive tool failures: ${consecutiveToolFailures}`);
          const taskSnippet = input.length > 200 ? input.slice(0, 200) + "..." : input;
          const taskReminder = t("exec.task_reminder", { task: taskSnippet });
          contextManager.addMessage({
            role: "user",
            content: `<system-summary>${recoveryMsg}\n${taskReminder}</system-summary>`,
          });
        }
        contextManager.addMessage({
          role: "user",
          content: `<system-summary>${summaries.join("\n")}</system-summary>`,
        });
        continue;
      }

      const hallucinationResult = hallucinationDetector.validate(textContent);
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

      if (!sawToolCall) {
        if (this.deps.finalAudit) {
          const audit = await this.deps.finalAudit();
          if (audit && !audit.passed) {
            logger.warn(`Final audit incomplete: ${audit.summary}`);
            const steps =
              audit.pendingSteps.slice(0, 5).join("; ") || "—";
            contextManager.addMessage({
              role: "user",
              content: `<system-summary>${t("exec.audit_incomplete", {
                summary: audit.summary,
                steps,
              })}</system-summary>`,
            });
            slog.logAudit(audit.summary, iteration);
            if (iteration >= config.maxToolIterations - 1) {
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
    };
  }

  clearContext(): void {
    this.deps.contextManager.clear();
    this.systemPromptAdded = false;
  }

  setContext(
    messages: Array<{ role: string; content: string | ContentPart[]; name?: string }>,
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
