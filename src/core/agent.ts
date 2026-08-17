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
import { MemoryStore } from "../modules/memory/store";
import { StepVerifier } from "../modules/execution/verifier";

const TOOL_RESULT_MAX_TOKENS_RATIO = 0.3;
const TOOL_RESULT_ABSOLUTE_MAX_CHARS = 15000;
const QUALITY_TRIGGER_THRESHOLD = 40;

/** Minimum iterations between quality-triggered forced compactions. Without
 * this, a low-quality context re-triggers compaction on EVERY iteration
 * (observed: 56 compactions in ~28 min) and the compaction itself can't
 * restore quality, so the agent burns the whole budget compacting. */
const FORCED_COMPACTION_COOLDOWN = 3;

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

/**
 * Max chars a tool result may occupy, given remaining budget and whether
 * the tool bounds its own output. Tools that declare `boundedOutput` (e.g.
 * read_file with its line limit) are never truncated by the budget — a
 * near-full context used to cut them to ~2K chars, making the model believe
 * files were truncated and re-read them forever.
 */
export function toolOutputCharLimit(
  remainingBudget: number,
  historyBudget: number,
  bounded: boolean,
): number {
  if (bounded) return Number.MAX_SAFE_INTEGER;
  const maxCharsByRatio = Math.floor(historyBudget * TOOL_RESULT_MAX_TOKENS_RATIO * 2);
  return Math.min(remainingBudget, maxCharsByRatio, TOOL_RESULT_ABSOLUTE_MAX_CHARS);
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
  memoryStore?: MemoryStore;
  exitOnComplete?: boolean;
}

export class Agent {
  private deps: AgentDeps;
  private systemPromptAdded = false;
  private shutdownRequested = false;
  private abortController: AbortController | null = null;
  private lastCompactionShown = 0;

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

  private buildSystemPrompt(): {
    prompt: string;
    excluded: string[];
    blocks: Array<{
      label: string;
      priority: string;
      tokens: number;
      included: boolean;
    }>;
  } {
    const systemBudget = Math.floor(
      this.deps.config.contextWindow * this.deps.config.contextBudget.systemPrompt,
    );
    const builder = new PromptBuilder(systemBudget);
    builder.addBlocks(this.deps.promptBlocks);
    const dynamic = this.deps.getDynamicPromptBlocks?.() ?? [];
    if (dynamic.length > 0) {
      builder.addBlocks(dynamic);
    }
    const pluginBlocks: PromptBlock[] = (
      this.deps.pluginManager.runOnBuildPrompt?.() ?? []
    ).flatMap((content): PromptBlock[] =>
      content && content.trim() !== ""
        ? [
            {
              content,
              priority: "low" as const,
              essential: false,
              estimatedTokens: this.deps.llmProvider.countTokens(content),
            },
          ]
        : [],
    );
    if (pluginBlocks.length > 0) {
      builder.addBlocks(pluginBlocks);
    }
    const result = builder.build();
    return {
      prompt: result.prompt,
      excluded: result.excluded,
      blocks: result.blocks,
    };
  }

  /**
   * Log the current context state to the session log. Called every iteration
   * so the session.jsonl shows a full timeline of how the context grows,
   * compacts, and what it consists of. The `start` snapshot additionally
   * carries the system-prompt block breakdown (which blocks, priorities,
   * token estimates, what was excluded by the budget).
   */
  private logContextStat(
    kind: "start" | "iteration",
    iteration: number,
    slog: SessionLogger,
    blocks?: Array<{
      label: string;
      priority: string;
      tokens: number;
      included: boolean;
    }>,
  ): void {
    const cm = this.deps.contextManager;
    if (typeof cm.getSnapshot !== "function") return;
    const snap = cm.getSnapshot();
    const history = cm.getActiveHistory();
    const systemMsg = history.find((m) => m.role === "system");
    slog.logContext({
      kind,
      iteration,
      window: snap.window,
      systemBudget: snap.budget.systemPrompt,
      reserveBudget: snap.budget.responseReserve,
      historyBudget: snap.budget.history,
      systemTokens:
        kind === "start" && systemMsg && typeof systemMsg.content === "string"
          ? this.deps.llmProvider.countTokens(systemMsg.content)
          : undefined,
      toolTokens: snap.toolTokens,
      tokens: snap.tokens,
      quality: snap.quality,
      messageCount: snap.messageCount,
      compactionCount: snap.compactionCount,
      iterationsSinceCompaction: snap.iterationsSinceCompaction,
      blocks,
    });
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

  /**
   * Some OpenAI-compatible backends (llama.cpp) omit `usage` from responses,
   * leaving apiPromptTokens/apiCompletionTokens at 0. Fall back to local
   * estimates so JSON results still carry meaningful token metrics.
   */
  private resolveUsageTokens(
    apiPromptTokens: number,
    apiCompletionTokens: number,
    estimatedPromptTokens: number,
    completionChars: number,
  ): { prompt: number; completion: number; total: number } {
    if (apiPromptTokens > 0 || apiCompletionTokens > 0) {
      return {
        prompt: apiPromptTokens,
        completion: apiCompletionTokens,
        total: apiPromptTokens + apiCompletionTokens,
      };
    }
    // ~4 chars per token is a reasonable heuristic when the backend gives
    // us nothing (matches the pre-tiktoken fallback elsewhere in the code).
    const prompt = Math.max(1, estimatedPromptTokens);
    const completion = Math.max(0, Math.ceil(completionChars / 4));
    return { prompt, completion, total: prompt + completion };
  }

  private refreshSystemPrompt(): void {
    const { prompt } = this.buildSystemPrompt();
    const current = this.deps.contextManager.getActiveHistory().find((m) => m.role === "system");
    if (!current || current.content !== prompt) {
      this.deps.contextManager.updateSystemPrompt?.(prompt);
    }
  }

  private truncateToolOutput(
    output: string,
    budget: { history: number },
    currentTokens: number,
    bounded: boolean,
  ): string {
    const remainingBudget = Math.max(0, budget.history - currentTokens);
    const maxChars = toolOutputCharLimit(remainingBudget, budget.history, bounded);
    if (output.length <= maxChars) return output;

    const truncated = output.slice(0, maxChars);
    const removedChars = output.length - maxChars;
    return truncated + `\n\n${t("tool.truncated", { tokens: Math.ceil(removedChars / 2) })}`;
  }

  private emitPhase(
    iteration: number,
    phase: AgentPhase,
    onPhase?: (phase: AgentPhase) => void,
  ): void {
    this.deps.pluginManager.runOnPhase?.(
      {
        iteration,
        logger: this.deps.logger,
        contextManager: this.deps.contextManager,
      },
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

    const slog = new SessionLogger(sessionManager, logger);

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
        contextManager,
      });

      if (config.session?.baselineCheck !== false) {
        const verifier = new StepVerifier(baseDir);
        verifier
          .runTypeCheck()
          .then((tc) => {
            if (!tc.passed) {
              logger.warn(`Baseline typecheck has issues: ${tc.message?.slice(0, 500)}`);
              onMeta?.(pc.yellow(`\n⚠ Baseline typecheck has issues\n`));
            }
          })
          .catch(() => {});
      }
    }

    // A new user message starts a fresh compaction interval — iterations
    // from the previous turn must not trigger a compaction on iteration 1
    // of this one (observed: turn 2 compacted at iteration 8, deleting the
    // just-sent task along with 40+ old turns).
    if (typeof contextManager.resetUserTurn === "function") {
      contextManager.resetUserTurn();
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
      baseDir,
    } = this.deps;

    const slog = new SessionLogger(sessionManager, logger);
    this.abortController = new AbortController();
    let iteration = 0;
    let lastText = "";
    // The actual most-recent model output (tool commentary, retried answers
    // included). Repetition is compared against THIS, not the last *accepted*
    // text — a frozen accepted answer made consecutive retries compare
    // against a stale baseline and flag every re-answer as repetitive.
    let lastModelText = "";
    let lastForcedCompactionIteration = -FORCED_COMPACTION_COOLDOWN;
    let hallucinationRetries = 0;
    let lastToolSignature = "";
    let apiPromptTokens = 0;
    let apiCompletionTokens = 0;
    let apiCompletionChars = 0;
    const MAX_HALLUCINATION_RETRIES = 3;
    let consecutiveToolFailures = 0;
    const MAX_CONSECUTIVE_TOOL_FAILURES = 5;
    // Per-tool failure counts and which tools already produced a memory rule.
    const toolFailureCounts = new Map<string, { count: number; error: string }>();
    const memoryRuleRecorded = new Set<string>();
    const MIN_REPEATED_TOOL_FAILURES = 3;
    let auditRetries = 0;
    const MAX_AUDIT_RETRIES = 3;
    let emptyResponseRetries = 0;
    const MAX_EMPTY_RESPONSE_RETRIES = 2;
    let emptyResponseExhausted = false;
    let auditFailed = false;
    let lastAuditSummary = "";
    // Set when the audit gate rejects a final answer and re-prompts: the next
    // non-tool response is then a re-answer of an already-completed task, so
    // a repetition verdict is expected and must not burn a hallucination retry.
    let suppressRepetitionRetry = false;
    let repeatedToolCount = 0;
    const MAX_REPEATED_TOOL_CALLS = 2;

    // Account for tool definitions in context budget (they're sent via body.tools, not messages)
    // Tool definitions are recomputed each iteration so `enable_tools`
    // (which mutates the shared activeToolTags array) can grow the
    // LLM-visible tool set mid-run. Bound per-iteration to keep the budget
    // estimate and boundedOutput set in sync with what is actually sent.
    let allToolsForBudget = toolExecutor.getToolDefinitions(this.deps.toolTags);
    let boundedToolNames = new Set(
      allToolsForBudget.filter((t) => t.boundedOutput).map((t) => t.name),
    );
    let toolTokenEstimate = allToolsForBudget.reduce(
      (sum, t) => sum + Math.ceil((t.description.length + JSON.stringify(t.parameters).length) / 4),
      0,
    );
    contextManager.setToolTokens(toolTokenEstimate);

    while (iteration < config.maxToolIterations && !this.shutdownRequested) {
      iteration++;
      contextManager.noteIteration();

      // Re-read the mutable tag set in case enable_tools was called.
      allToolsForBudget = toolExecutor.getToolDefinitions(this.deps.toolTags);
      boundedToolNames = new Set(
        allToolsForBudget.filter((t) => t.boundedOutput).map((t) => t.name),
      );
      toolTokenEstimate = allToolsForBudget.reduce(
        (sum, t) =>
          sum + Math.ceil((t.description.length + JSON.stringify(t.parameters).length) / 4),
        0,
      );
      contextManager.setToolTokens(toolTokenEstimate);

      pluginManager.runOnBeforeThink({
        iteration,
        logger,
        lastUserMessage: input,
        contextManager,
        onMeta,
        sessionLog: {
          plan: (event: string, detail: string, iter?: number) => slog.logPlan(event, detail, iter),
        },
      });

      if (contextManager.needsCompaction()) {
        const result = contextManager.compact();
        if (result) {
          logger.debug("Context compacted");
          slog.logCompaction({ reason: "interval", iteration, ...result });
        }
      }

      const currentTokens = contextManager.getEstimatedTokens();
      const budget = contextManager.getBudget();
      const quality = contextManager.getQuality();
      if (
        quality < QUALITY_TRIGGER_THRESHOLD &&
        contextManager.getCompactionCount() > 0 &&
        iteration - lastForcedCompactionIteration >= FORCED_COMPACTION_COOLDOWN
      ) {
        lastForcedCompactionIteration = iteration;
        const result = contextManager.compact();
        logger.warn(`Low context quality (${quality}%) — forced compaction`);
        if (result) {
          slog.logCompaction({
            reason: `quality-triggered (${quality}% < ${QUALITY_TRIGGER_THRESHOLD}%)`,
            iteration,
            ...result,
          });
        }
      }
      if (currentTokens > budget.history) {
        const result = contextManager.compact();
        logger.warn(`Context overflow (${currentTokens} > ${budget.history}), forced compaction`);
        if (result) {
          slog.logCompaction({
            reason: `overflow (${currentTokens} > ${budget.history})`,
            iteration,
            ...result,
          });
        }
      }

      this.refreshSystemPrompt();
      const history = contextManager.getActiveHistory();

      slog.logToolDefs(
        allToolsForBudget.length,
        allToolsForBudget.map((t) => t.name),
        iteration,
      );

      if (iteration === 1) {
        const { blocks } = this.buildSystemPrompt();
        this.logContextStat("start", iteration, slog, blocks);
      } else {
        this.logContextStat("iteration", iteration, slog);
      }

      let textContent = "";
      let reasoningContent = "";
      const toolCalls: ToolCall[] = [];
      let sawToolCall = false;
      let emittedReasoning = false;
      const textChunks: string[] = [];

      this.emitPhase(iteration, "thinking", onPhase);
      const llmStart = Date.now();
      const promptBefore = apiPromptTokens;
      const completionBefore = apiCompletionTokens;
      logger.logLLMRequest(config.model, history.length, input, "agent");
      try {
        for await (const chunk of llmProvider.chat(
          history,
          allToolsForBudget as ToolDefinition[],
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
                { iteration, logger, contextManager },
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
        logger.logLLMResponse(
          config.model,
          textContent.length,
          Date.now() - llmStart,
          err.message,
          "agent",
        );
        logger.error(`LLM call failed: ${err.message}`);
        slog.logError(err.message);
        pluginManager.runOnError({ iteration, logger, contextManager }, err);
        return {
          success: false,
          text: lastText,
          error: t("error.llm", { message: err.message }),
          iterationCount: iteration,
        };
      } finally {
        this.emitPhase(iteration, "done", onPhase);
      }

      // Track response length so token metrics stay meaningful even when
      // the backend omits `usage` from the response.
      apiCompletionChars += (textContent || reasoningContent).length;

      logger.logLLMResponse(
        config.model,
        (textContent || reasoningContent).length,

        Date.now() - llmStart,
        undefined,
        "agent",
      );

      // Log per-call token usage. llama.cpp streaming often omits `usage`,
      // so fall back to local estimates (context tokens + chars/4) and
      // mark the source — the log must distinguish real API numbers from
      // heuristics.
      {
        const usagePrompt = apiPromptTokens - promptBefore;
        const usageCompletion = apiCompletionTokens - completionBefore;
        const source: "api" | "estimate" =
          usagePrompt > 0 || usageCompletion > 0 ? "api" : "estimate";
        const prompt = source === "api" ? usagePrompt : contextManager.getEstimatedTokens();
        const completion =
          source === "api"
            ? usageCompletion
            : Math.ceil((textContent || reasoningContent).length / 4);
        slog.logLlmUsage(iteration, {
          promptTokens: prompt,
          completionTokens: completion,
          totalTokens: prompt + completion,
          source,
          durationMs: Date.now() - llmStart,
        });
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
        textChunks.length > 0 && (!sawToolCall || (toolComments && !isToolCallJson(textContent)));
      if (showText) {
        for (const chunk of textChunks) {
          const textOut = pluginManager.runOnText({ iteration, logger, contextManager }, chunk);
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
      pluginManager.runOnAfterThink({ iteration, logger, contextManager }, llmResponse);

      if (this.deps.exitOnComplete && sawToolCall) {
        const signature = toolCalls
          .map((tc) => `${tc.name}:${JSON.stringify(tc.arguments)}`)
          .join("|");
        if (signature && signature === lastToolSignature) {
          // A repeated identical tool call is often the model re-running
          // a command after a confusing result. Give it one more chance
          // to produce a final text answer instead of stopping with
          // text: "" (observed on 08-r4: bash re-run → empty result).
          repeatedToolCount++;
          if (repeatedToolCount >= MAX_REPEATED_TOOL_CALLS) {
            logger.debug("Exit-on-complete: repeated identical tool call, stopping");
            break;
          }
          contextManager.addMessage({
            role: "user",
            content: `<system-summary>You just called the same tool with identical arguments. If the task is done, answer with a final text response NOW. If the command failed, try a different approach.</system-summary>`,
          });
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
            { iteration, logger, contextManager },
            { id: call.id, name: call.name, arguments: call.arguments },
          );
          onTool?.({ type: "start", tool: call.name, args: call.arguments });
          slog.logToolCall(call, iteration);

          const tokensBeforeTool = contextManager.getEstimatedTokens();
          const result = await toolExecutor.execute(call, this.abortController?.signal);
          const duration = Date.now() - startTime;
          if (!result.success) anyToolFailed = true;

          if (result.success && call.arguments.path) {
            const filePath = String(call.arguments.path);
            if (call.name === "write_file" || call.name === "edit_file") {
              hallucinationDetector.getConsistencyCheck().trackCreatedFile(filePath);
            } else if (call.name === "delete_file") {
              hallucinationDetector.getConsistencyCheck().trackDeletedFile(filePath);
            }
          }

          pluginManager.runOnToolEnd(
            { iteration, logger, contextManager },
            { id: call.id, name: call.name, arguments: call.arguments },
            result,
            duration,
          );
          if (result.display) {
            onMeta?.("\n" + result.display + "\n");
          } else {
            const metaOut = pluginManager.runOnMeta(
              { iteration, logger, contextManager },
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
            boundedToolNames.has(call.name),
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
            const result = contextManager.compact();
            if (result) {
              logger.debug("Context compacted after tool result");
              slog.logCompaction({
                reason: "after_tool",
                iteration,
                ...result,
              });
            }
          }
          // Track per-tool failure counts (NOT just consecutive) so a tool
          // that keeps failing while other tools succeed between attempts
          // is still learned from (observed: LSP spawn npx ENOENT failed
          // 8x in one session, never consecutively, so it never reached
          // memory via the 5-consecutive-failures path).
          if (!result.success) {
            const key = call.name;
            const prev = toolFailureCounts.get(key) ?? { count: 0, error: "" };
            prev.count++;
            prev.error = String(result.output ?? "").slice(0, 200);
            toolFailureCounts.set(key, prev);
            if (prev.count >= MIN_REPEATED_TOOL_FAILURES && !memoryRuleRecorded.has(key)) {
              memoryRuleRecorded.add(key);
              const memStore = this.deps.memoryStore;
              if (memStore) {
                memStore.appendRule(
                  "errors",
                  `Tool ${key} failed ${prev.count}x (${prev.error})`,
                  `Repeated ${key} failures suggest a systemic problem (config, environment, or a broken tool), not a one-off`,
                  "Check the error message, verify the tool's dependencies are installed/configured, and consider a different tool",
                );
                logger.warn(`Recorded repeated ${key} failures to memory (${prev.count}x)`);
              }
            }
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
          const taskSnippet = input.length > 200 ? input.slice(0, 200) + "..." : input;
          const taskReminder = t("exec.task_reminder", { task: taskSnippet });
          contextManager.addMessage({
            role: "user",
            content: `<system-summary>${recoveryMsg}\n${taskReminder}</system-summary>`,
          });

          const memStore = this.deps.memoryStore;
          if (memStore) {
            memStore.appendRule(
              "errors",
              `${consecutiveToolFailures} consecutive tool failures`,
              "Multiple tools failing suggests environment or configuration issue",
              "Check dependencies, verify file paths, try write_file directly instead of shell commands",
            );
          }
        }
        contextManager.addMessage({
          role: "user",
          content: `<system-summary>${summaries.join("\n")}</system-summary>`,
        });

        const ui = this.deps.config.ui;
        if (ui?.showContextStats) {
          const ctxTokens = contextManager.getEstimatedTokens();
          const ctxBudget = contextManager.getBudget();
          const ctxPct = Math.min(100, Math.round((ctxTokens / ctxBudget.history) * 100));
          const barLen = 10;
          const filled = Math.round((ctxPct / 100) * barLen);
          const ctxBar = pc.green("█".repeat(filled)) + pc.dim("░".repeat(barLen - filled));
          const pctColor = ctxPct >= 75 ? pc.yellow : pc.dim;
          const compCount = contextManager.getCompactionCount();
          const quality = contextManager.getQuality();
          const qualityColor = quality >= 70 ? pc.green : quality >= 40 ? pc.yellow : pc.red;
          onMeta?.(
            `\n  ${ctxBar}  ${pctColor(`${ctxPct}%`)}  ${pc.dim(`ctx: ${ctxTokens}/${ctxBudget.history}`)}  ${pc.dim(`compactions: ${compCount}`)}  ${qualityColor(`quality: ${quality}%`)}\n`,
          );
        } else if (ui?.showCompaction) {
          const compCount = contextManager.getCompactionCount();
          if (compCount > this.lastCompactionShown) {
            this.lastCompactionShown = compCount;
            onMeta?.(pc.dim(`\n  ⟳ Context compacted (${compCount})\n`));
          }
        }

        // A tool call means the model kept working instead of just
        // re-answering — the audit-re-answer leniency no longer applies.
        suppressRepetitionRetry = false;
        continue;
      }

      hallucinationDetector.getConfidenceCheck().setPreviousResponse(lastModelText);
      // Update AFTER setPreviousResponse so the comparison uses the
      // previous iteration's output, not this one (which would otherwise
      // always overlap with itself).
      if (textContent) lastModelText = textContent;
      const hallucinationResult = await hallucinationDetector.validate(textContent);
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
        const warnLine = `${t("hall.uncertainty_prefix").trim()} ${
          hallucinationResult.reason ?? ""
        }`;
        if (onMeta) {
          onMeta(`\n${pc.yellow(warnLine)}\n`);
        } else if (onChunk) {
          onChunk(`\n${warnLine}\n`);
        }
      }
      if (hallucinationResult.status === "retry") {
        if (this.deps.exitOnComplete && textContent?.trim()) {
          logger.debug("Exit-on-complete: stopping on first response");
          // Save the response BEFORE breaking — lastText is still the
          // previous (tool-only) iteration's text, so without this the
          // final answer is lost (reported text: "").
          lastText = textContent;
          break;
        }
        if (suppressRepetitionRetry && hallucinationResult.kind === "repetition") {
          // The audit gate rejected the previous final answer and
          // re-prompted the model. Its re-answer restating the completed
          // task is naturally "repetitive" — that is expected, not
          // degeneration. Downgrade to a warning and let the response
          // flow through to the final audit gate again (which is itself
          // bounded by MAX_AUDIT_RETRIES).
          suppressRepetitionRetry = false;
          logger.warn(`Audit-triggered re-answer repetition — not counted as hallucination retry`);
          const warnLine = `${t("hall.uncertainty_prefix").trim()} ${
            hallucinationResult.reason ?? ""
          }`;
          if (onMeta) {
            onMeta(`\n${pc.yellow(warnLine)}\n`);
          } else if (onChunk) {
            onChunk(`\n${warnLine}\n`);
          }
          // fall through to the acceptance path below (assistant message,
          // lastText, final audit gate).
        } else {
          // NOTE: with exitOnComplete and an EMPTY text we deliberately
          // do NOT break — the model produced no usable answer yet (same
          // case as the empty-response guard below). Falling through to
          // the retry path keeps us from finishing with text: "".
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
      }

      if (textContent) {
        contextManager.addMessage({ role: "assistant", content: textContent });
        if (config.session.autoSave) {
          slog.saveAssistantMessage(textContent);
        }
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
        // Guard: the model returned an EMPTY final response (no text, no
        // tool calls — often just reasoning content after context
        // compaction). Nudge it to produce a real answer instead of
        // silently finishing with text: "".
        if (!textContent?.trim()) {
          if (emptyResponseRetries < MAX_EMPTY_RESPONSE_RETRIES) {
            emptyResponseRetries++;
            logger.warn(
              `Empty response on iteration ${iteration} (retry ${emptyResponseRetries}/${MAX_EMPTY_RESPONSE_RETRIES})`,
            );
            contextManager.addMessage({
              role: "user",
              content: `<system-summary>Your previous response was empty. Answer the user's task now with a final text response or call a tool. Do not reply with reasoning only.</system-summary>`,
            });
            continue;
          }
          emptyResponseExhausted = true;
          logger.warn(
            `Empty response retries exhausted after ${MAX_EMPTY_RESPONSE_RETRIES} attempts`,
          );
        }
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
            lastAuditSummary = audit.summary;
            if (auditRetries >= MAX_AUDIT_RETRIES || iteration >= config.maxToolIterations - 1) {
              logger.warn(
                `Final audit still incomplete after ${auditRetries} retries — reporting failure`,
              );
              auditFailed = true;
              break;
            }
            // The next non-tool response is a forced re-answer of an
            // already-completed task — allow one repetition without
            // burning the hallucination budget (see retry branch).
            suppressRepetitionRetry = true;
            continue;
          }
        }
        break;
      }
    }

    const tokensUsed = contextManager.getEstimatedTokens();
    const budget = contextManager.getBudget();
    const usageTokens = this.resolveUsageTokens(
      apiPromptTokens,
      apiCompletionTokens,
      tokensUsed,
      apiCompletionChars,
    );

    if (iteration >= config.maxToolIterations) {
      return {
        success: false,
        text: lastText,
        error: t("error.max_iters", { max: config.maxToolIterations }),
        iterationCount: iteration,
        contextUsed: tokensUsed,
        contextLimit: budget.history,
        promptTokens: usageTokens.prompt,
        completionTokens: usageTokens.completion,
        totalTokens: usageTokens.total,
        compactionCount: contextManager.getCompactionCount(),
        contextQuality: contextManager.getQuality(),
      };
    }

    return {
      success: emptyResponseExhausted || auditFailed ? false : true,
      text: lastText,
      error: emptyResponseExhausted
        ? t("error.empty_response")
        : auditFailed
          ? t("error.audit_failed", { summary: lastAuditSummary })
          : undefined,
      iterationCount: iteration,
      contextUsed: tokensUsed,
      contextLimit: budget.history,
      promptTokens: usageTokens.prompt,
      completionTokens: usageTokens.completion,
      totalTokens: usageTokens.total,
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
    (this.deps.toolExecutor as any).ctx.llmProvider = newProvider;
    const newTokenCounter = new TokenCounter(config.model);
    this.deps.contextManager.resize(config.contextWindow, config.contextBudget, newTokenCounter);
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
    logger.closeSessionLog();
    pluginManager.runOnSessionEnd({
      logger,
      sessionManager: sessionManager?.getActiveMeta(),
      contextManager,
    });
  }
}
