import type { LLMProvider, ContentPart } from "../llm/provider";
import { ProviderManager } from "../modules/providers/manager";
import type { ToolExecutor } from "../tools/executor";
import type { PluginManager } from "../modules/plugins/manager";
import type { ContextManager, Message } from "../modules/context/manager";
import type { HallucinationDetector } from "../modules/hallucination/detector";
import type { Logger } from "../logger/app-logger";
import type { AppConfig, ProviderEntry } from "../config/types";
import type { ToolScope, ToolDefinition } from "../tools/types";
import type { PromptBlock } from "./types";
import type { EnvironmentReport } from "./environment";
import type { ToolCall, ToolEvent, AgentPhase, LLMResponse, AgentResult } from "./types";
import type { SessionManager } from "../modules/session/manager";
import type { ModuleRegistry } from "../modules/registry";
import { t } from "../i18n/index";
import { pc } from "../ui/colors";
import { PromptBuilder } from "./prompt-builder";
import { processRegistry } from "../modules/processes";
import { SessionLogger } from "./session-logger";
import { runWithMoE } from "./agent-moe";
import { MemoryStore } from "../modules/memory/store";
import { CostTracker } from "../modules/pricing/index";
import { evaluateReasoningPolicy, createPolicyState } from "../modules/reasoning/policy";
import type { PolicyState } from "../modules/reasoning/policy";
import type { ReasoningLevel } from "../config/types";
import type { ReasoningState } from "../tools/set-thinking";
import { estimateTokens } from "../llm/token-counter";

const TOOL_RESULT_MAX_TOKENS_RATIO = 0.3;
const TOOL_RESULT_ABSOLUTE_MAX_CHARS = 15000;
const QUALITY_TRIGGER_THRESHOLD = 40;
/** Max chars of a tool's arguments shown in the <system-summary> envelope.
 * A write_file's `content` (or any large arg) must not be duplicated into the
 * summary on top of the role:"tool" message that already carries the result. */
const TOOL_ARGS_SUMMARY_MAX_CHARS = 240;

/** JSON-stringify tool args, truncated to a bounded size for the summary envelope. */
function summarizeToolArgs(args: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(args);
  } catch {
    s = String(args);
  }
  if (!s || s === "{}") return "";
  if (s.length <= TOOL_ARGS_SUMMARY_MAX_CHARS) return ` (${s})`;
  return ` (${s.slice(0, TOOL_ARGS_SUMMARY_MAX_CHARS)}…(${s.length} chars total))`;
}

/** Minimum iterations between quality-triggered forced compactions. Without
 * this, a low-quality context re-triggers compaction on EVERY iteration
 * (observed: 56 compactions in ~28 min) and the compaction itself can't
 * restore quality, so the agent burns the whole budget compacting. */
const FORCED_COMPACTION_COOLDOWN = 3;
const MAX_LLM_ERROR_RETRIES = 2;

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
  /**
   * Shared live-config box. `reconfigure` swaps both `config` and
   * `configRef.current` so bootstrap-captured references (toolCtx.config,
   * security validators) keep seeing the current settings.
   */
  configRef?: { current: AppConfig };
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
  /**
   * Prompt blocks computed asynchronously (e.g. the startup LSP/tsc health
   * check). The promise starts at bootstrap so it never blocks the banner;
   * `run()` awaits it before the first system prompt so the model still gets
   * the baseline before the first LLM call. Only the first `run()` waits.
   */
  lazyPromptBlocks?: () => Promise<PromptBlock[]>;
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
  moduleRegistry?: ModuleRegistry;
  exitOnComplete?: boolean;
  envReport?: EnvironmentReport;
  /**
   * Whether the reasoning effort mechanism was validated by probe. Initial
   * value only — the live result comes from `reasoningProbe` (B2), which the
   * agent awaits lazily before the first LLM call.
   */
  reasoningProbePassed?: boolean;
  /**
   * Resolves the background reasoning probe. Consumed lazily next to
   * `lazyPromptBlocks` so bootstrap never blocks on the probe LLM round-trip;
   * until resolved the mechanism is treated as NOT passed.
   */
  reasoningProbe?: () => Promise<boolean>;
  /** Strategy for expressing reasoning effort on this provider. */
  reasoningStrategy?: import("../config/types").ReasoningStrategy;
}

export class Agent {
  private deps: AgentDeps;
  private systemPromptAdded = false;
  private shutdownRequested = false;
  private abortController: AbortController | null = null;
  private lastCompactionShown = 0;
  private costTracker: CostTracker;
  private policyState: PolicyState;
  /** Reasoning probe result (B2): starts from deps, refreshed lazily in run(). */
  private probePassed: boolean;
  /** Shared mutable reasoning state (owned by agent, shared with set_thinking tool). */
  readonly reasoningState: ReasoningState;
  /** Current iteration counter (exposed for tool cooldown checks). */
  private _currentIteration = 0;

  constructor(deps: AgentDeps) {
    this.deps = deps;
    this.costTracker = new CostTracker(deps.config.model, deps.config.pricing);
    this.policyState = createPolicyState();
    this.probePassed = deps.reasoningProbePassed ?? false;
    const initialLevel = (deps.config.reasoning?.mode !== "auto" ? deps.config.reasoning?.mode : undefined) ?? "medium";
    this.reasoningState = { level: initialLevel, overrideIteration: -100 };
  }

  /** Expose context manager for REPL image attachment and other direct access. */
  get contextManager(): ContextManager {
    return this.deps.contextManager;
  }

  /** Current effective reasoning level. */
  get reasoningLevel(): ReasoningLevel {
    return this.reasoningState.level;
  }

  /** Set reasoning level (used by REPL and CLI). */
  setReasoningLevel(level: ReasoningLevel): void {
    this.reasoningState.level = level;
  }

  /** Current iteration number (for tool cooldown checks). */
  get currentIteration(): number {
    return this._currentIteration;
  }

  callerProvenance(): { provider: string; model: string } {
    return {
      provider: this.deps.config.provider?.type || "unknown",
      model: this.deps.config.model,
    };
  }

  /** Typed module accessor for CLI/REPL commands (e.g. /lsp). */
  getModule<T>(name: string): T | undefined {
    return this.deps.moduleRegistry?.get(name) as T | undefined;
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
    // Reset shutdown flag from previous interrupt
    this.shutdownRequested = false;
    // Fresh controller per turn — the MoE path relies on it for Esc handling
    // (executeSingleAgentLoop re-creates it again for the single-agent path).
    this.abortController = new AbortController();
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

    const slog = new SessionLogger(sessionManager, logger, () => this.callerProvenance());

    if (sessionManager && !sessionManager.getActive()) {
      sessionManager.create();
      logger.debug(`Session started: ${sessionManager.getActive()}`);
    }

    if (
      !this.systemPromptAdded &&
      !contextManager.getActiveHistory().some((m) => m.role === "system")
    ) {
      // Log session startup diagnostics (environment, plugins, skills) as the
      // first entry in session.jsonl so the file is self-describing for
      // post-mortem analysis. LSP probe is logged separately from repl.ts
      // since it may complete after this point. Dedup: logSessionStart
      // checks for existing session_start entry to avoid double-logging.
      slog.logSessionStart({
        environment: this.deps.envReport as unknown as Record<string, unknown>,
      });

      const lazy = this.deps.lazyPromptBlocks ? await this.deps.lazyPromptBlocks() : [];
      if (lazy.length > 0) {
        this.deps.promptBlocks.push(...lazy);
      }
      // B2: await the background reasoning probe next to the lazy prompt
      // blocks so the FIRST LLM call already knows whether the backend
      // respects the reasoning mechanism (bootstrap no longer blocks on it).
      if (this.deps.reasoningProbe) {
        this.probePassed = await this.deps.reasoningProbe();
      }
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

    // Turn lifecycle for plugins: count tool events without touching the loop,
    // and dispatch onTurnEnd exactly once — success, error or interrupt.
    const startedAt = Date.now();
    let toolCalls = 0;
    const countTool = (ev: ToolEvent) => {
      if (ev.type === "end") toolCalls++;
      onTool?.(ev);
    };
    const emitTurnEnd = (result: AgentResult | null, err?: unknown) => {
      const interrupted =
        (err instanceof Error && err.name === "AbortError") || this.shutdownRequested;
      pluginManager.runOnTurnEnd?.(
        {
          logger,
          sessionManager: sessionManager?.getActiveMeta(),
          contextManager,
        },
        {
          success: !!result && result.success !== false && !err,
          durationMs: Date.now() - startedAt,
          textLength: (result?.text || "").length,
          toolCalls,
          interrupted: interrupted || undefined,
        },
      );
    };

    try {
      const moeEnabled = config.moe?.enabled === true;
      const result = moeEnabled
        ? await runWithMoE(
            {
              config,
              llmProvider,
              toolExecutor,
              logger,
              baseDir: this.deps.baseDir,
            },
            input,
            () => this.executeSingleAgentLoop(input, onChunk, onMeta, countTool, onPhase),
            {
              onMeta,
              onTool: countTool,
              onPhase,
              signal: this.abortController.signal,
            },
          )
        : await this.executeSingleAgentLoop(input, onChunk, onMeta, countTool, onPhase);

      // In MoE mode the single-agent loop (the only writer of assistant turns)
      // never runs — without this the history ends user→user across turns and
      // session.jsonl is missing the assistant answer. Write the result once,
      // only when MoE actually handled the turn (a fallback already wrote it).
      if (moeEnabled && result.moeHandled) {
        if (result.text) {
          contextManager.addMessage({ role: "assistant", content: result.text });
          if (config.session.autoSave) {
            slog.saveAssistantMessage(result.text);
          }
          slog.logAssistant(result.text, "", undefined, 0);
        }
        if (!result.success && result.error) {
          slog.logError(result.error);
        }
      }

      const provenance = this.callerProvenance();
      result.provider = provenance.provider;
      result.model = provenance.model;
      result.durationMs = Date.now() - startedAt;
      emitTurnEnd(result);
      return result;
    } catch (err) {
      emitTurnEnd(null, err);
      throw err;
    }
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

    const slog = new SessionLogger(sessionManager, logger, () => this.callerProvenance());
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
    // Cumulative estimated prompt tokens across iterations. When the backend
    // omits `usage`, the completion side (apiCompletionChars) is already
    // cumulative, so the prompt side must be too — otherwise the final token
    // metrics mix a point-in-time prompt with an all-session completion.
    let estimatedPromptTokensTotal = 0;
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
    // Set true right before the loop terminates with an accepted final answer.
    // Gates the max_iters error below: an answer produced on the LAST allowed
    // iteration is a success, not a "ran out of iterations" failure.
    let finalAnswerAccepted = false;
    let lastAuditSummary = "";
    let totalLlmDuration = 0;
    // Set when the audit gate rejects a final answer and re-prompts: the next
    // non-tool response is then a re-answer of an already-completed task, so
    // a repetition verdict is expected and must not burn a hallucination retry.
    let suppressRepetitionRetry = false;
    let repeatedToolCount = 0;
    const MAX_REPEATED_TOOL_CALLS = 2;
    let llmErrorRetries = 0;

    // Per-iteration reasoning signal flags (reset each iteration)
    let iterHallucinationRetry = false;
    let iterAuditRejection = false;
    let iterRecoverableLlmError = false;
    let iterPlanCreated = false;

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
      this._currentIteration = iteration;
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
          // Seed hallucination checker with files from compaction summary
          hallucinationDetector.addKnownFiles(contextManager.getKnownFiles());
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
          hallucinationDetector.addKnownFiles(contextManager.getKnownFiles());
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
          hallucinationDetector.addKnownFiles(contextManager.getKnownFiles());
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
      estimatedPromptTokensTotal += contextManager.getEstimatedTokens();
      logger.logLLMRequest(config.model, history.length, input, "agent");

      // Compute reasoning effort for this iteration. The signal flags describe
      // events of the PREVIOUS iteration (they are set on the retry/audit
      // paths right before `continue`), so evaluate the policy BEFORE
      // clearing them — otherwise the raise branch is unreachable.
      const reasoningConfig = config.reasoning;
      let effectiveReasoningLevel: ReasoningLevel | undefined;
      let reasoningStrategy = this.deps.reasoningStrategy;
      let reasoningSource = "policy";
      const overrideCooldown = reasoningConfig?.overrideCooldown ?? 0;
      const overrideAge = iteration - this.reasoningState.overrideIteration;
      const overrideActive =
        overrideCooldown > 0 &&
        this.reasoningState.overrideIteration >= 0 &&
        overrideAge > 0 &&
        overrideAge <= overrideCooldown;
      if (overrideActive) {
        // A set_thinking override wins over both policy (auto) and fixed mode.
        effectiveReasoningLevel = this.reasoningState.level;
        reasoningSource = "agent_override";
      } else if (reasoningConfig && reasoningConfig.mode === "auto" && this.probePassed) {
        const policyResult = evaluateReasoningPolicy({
          hallucinationRetry: iterHallucinationRetry,
          auditRejection: iterAuditRejection,
          recoverableLlmError: iterRecoverableLlmError,
          planCreated: iterPlanCreated,
          consecutiveSuccesses: 0,
          isRepetitive: false,
          baseline: "medium",
        }, this.policyState);
        effectiveReasoningLevel = policyResult.level;
        reasoningSource = "policy";
      } else if (reasoningConfig && reasoningConfig.mode !== "auto") {
        effectiveReasoningLevel = reasoningConfig.mode;
        reasoningSource = "fixed";
      }

      // Clear per-iteration signals now that the policy has consumed them.
      iterHallucinationRetry = false;
      iterAuditRejection = false;
      iterRecoverableLlmError = false;
      iterPlanCreated = false;

      // Log reasoning control event
      if (effectiveReasoningLevel) {
        slog.logReasoningControl({
          iteration,
          level: effectiveReasoningLevel,
          strategy: reasoningStrategy,
          probePassed: this.probePassed,
          source: reasoningSource,
        });
        contextManager.thinkingLevel = effectiveReasoningLevel;
      }

      try {
        for await (const chunk of llmProvider.chat(
          history,
          allToolsForBudget as ToolDefinition[],
          this.abortController?.signal,
          effectiveReasoningLevel ? { reasoningEffort: effectiveReasoningLevel, reasoningStrategy } : undefined,
        )) {
          if (this.shutdownRequested) break;
          if (chunk.type === "text" && chunk.content) {
            if (emittedReasoning && !textContent) {
              onMeta?.("\n\n");
            }
            textContent += chunk.content;
            textChunks.push(chunk.content);
            const textOut = pluginManager.runOnText({ iteration, logger, contextManager }, chunk.content);
            onChunk?.(textOut);
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
            // chat() is called ONCE per iteration — every `done` chunk here
            // belongs to the same logical request (a usage-only stream chunk
            // followed by the non-streaming fallback emits two done chunks).
            // REPLACE the running totals instead of accumulating, otherwise
            // one real request is counted twice.
            apiPromptTokens = promptBefore + chunk.usage.promptTokens;
            apiCompletionTokens = completionBefore + chunk.usage.completionTokens;
          }
        }
      } catch (err: any) {
        if (this.shutdownRequested || err?.name === "AbortError") {
          logger.info("LLM call aborted (interrupt)");
          break;
        }
        // Recoverable LLM errors (e.g. the completion hit the token limit
        // mid-tool_call): feed the localized reason back into context so the
        // model can adapt (split the write into smaller chunks) instead of
        // the whole session dying. Bounded to avoid infinite loops.
        if (err?.recoverableLlm && llmErrorRetries < MAX_LLM_ERROR_RETRIES) {
          iterRecoverableLlmError = true;
          llmErrorRetries++;
          logger.warn(
            `Recoverable LLM error, feeding back (${llmErrorRetries}/${MAX_LLM_ERROR_RETRIES}): ${err.message}`,
          );
          slog.logError(err.message);
          pluginManager.runOnError({ iteration, logger, contextManager }, err);
          contextManager.addMessage({
            role: "user",
            content: `<system-summary>${err.message}</system-summary>`,
          });
          continue;
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
      totalLlmDuration += Date.now() - llmStart;

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
            : estimateTokens(textContent || reasoningContent);
        slog.logLlmUsage(iteration, {
          promptTokens: prompt,
          completionTokens: completion,
          totalTokens: prompt + completion,
          source,
          durationMs: Date.now() - llmStart,
        });
        this.costTracker.record(prompt, completion, this.callerProvenance().provider);
      }

      if (this.shutdownRequested) {
        break;
      }

      // Show the model's commentary text. When a tool call accompanies the
      // response, keep the text too (opencode-like narration), unless it is
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
        const answeredToolCallIds = new Set<string>();
        // OpenAI-compatible backends (llama.cpp Jinja templates) reject with
        // HTTP 400 any history where an assistant(tool_calls) message is not
        // followed by role:"tool" results for every call id — an interrupt
        // mid-batch must not leave such a dangling pair behind.
        const synthesizePendingToolResults = () => {
          for (const call of toolCalls) {
            if (answeredToolCallIds.has(call.id)) continue;
            logger.debug(
              `Interrupted before tool ${call.name} (${call.id}) returned a result — synthesizing tool message`,
            );
            contextManager.addMessage({
              role: "tool",
              content: "[interrupted]",
              name: call.name,
              tool_call_id: call.id,
              success: false,
              arguments: call.arguments,
            });
          }
        };
        const summaries: string[] = [];
        let anyToolFailed = false;
        // Informational read-only tools whose "failure" is expected behavior
        // (e.g. file_info "Not found" after delete_file) — excluded from
        // per-tool failure counting and consecutive failure tracking.
        const infoTools = new Set(["file_info"]);
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
          const toolIcon = this.deps.toolExecutor.getRegistry().get(call.name)?.icon;
          onTool?.({ type: "start", tool: call.name, args: call.arguments, icon: toolIcon });
          slog.logToolCall(call, iteration);

          const tokensBeforeTool = contextManager.getEstimatedTokens();
          let result;
          try {
            result = await toolExecutor.execute(call, this.abortController?.signal);
          } catch (err) {
            // An abort during the tool must still propagate so the session
            // shuts down cleanly. Any OTHER throw (a bug in a tool or plugin
            // that escapes the executor's own catch) must NOT kill the whole
            // session — degrade it to a failed tool result the model can react
            // to, exactly like a tool returning success:false.
            if (err instanceof Error && err.name === "AbortError") {
              synthesizePendingToolResults();
              throw err;
            }
            logger.warn(
              `Tool ${call.name} threw: ${err instanceof Error ? err.message : String(err)}`,
            );
            result = {
              success: false,
              output: `${t("error.prefix")}${err instanceof Error ? err.message : String(err)}`,
              toolCallId: call.id,
            };
          }
          // Interrupt during the tool call: the session is already shutting
          // down (Esc/Ctrl+C), so stop immediately — no rendering, no session
          // log writes, no context update for a result nobody will see. This
          // fixes the "Replaced in ..." lines appearing AFTER "Session ended".
          if (this.shutdownRequested) break;
          const duration = Date.now() - startTime;
          if (!result.success && !infoTools.has(call.name)) anyToolFailed = true;

          if (result.success && call.name === "plan") {
            const action = String(call.arguments.action ?? "");
            if (action === "create" || action === "re-plan") iterPlanCreated = true;
          }
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
          // Presence check, not truthiness: read_file returns display ""
          // on a full read to suppress output entirely (the tool header
          // already shows the path) — falling back on empty string would
          // dump the whole file content into the REPL.
          if (result.display !== undefined) {
            if (result.display.length > 0) {
              onMeta?.("\n" + result.display + "\n");
            }
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
          answeredToolCallIds.add(call.id);

          const tokensAfterTool = contextManager.getEstimatedTokens();
          onTool?.({
            type: "end",
            tool: call.name,
            args: call.arguments,
            duration,
            error: !result.success,
            ctxDelta: tokensAfterTool - tokensBeforeTool,
            costUsd: this.costTracker.total,
          });

          summaries.push(
            `[Tool: ${call.name}${summarizeToolArgs(call.arguments)} → ${truncatedOutput.slice(0, 200)}]`,
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
              hallucinationDetector.addKnownFiles(contextManager.getKnownFiles());
            }
          }
          // Track per-tool failure counts (NOT just consecutive) so a tool
          // that keeps failing while other tools succeed between attempts
          // is still learned from (observed: LSP spawn npx ENOENT failed
          // 8x in one session, never consecutively, so it never reached
          // memory via the 5-consecutive-failures path).
          if (!result.success && !infoTools.has(call.name)) {
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
        if (this.shutdownRequested) {
          synthesizePendingToolResults();
          break;
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
        iterHallucinationRetry = true;
        // Exit-on-complete fast-exit must NOT bypass the final audit gate:
        // when a plan is active the model may be answering "done" while steps
        // are pending (cert regression: model replied without running its
        // script). Only short-circuit when there is nothing to audit.
        if (this.deps.exitOnComplete && textContent?.trim() && !this.deps.finalAudit) {
          logger.debug("Exit-on-complete: stopping on first response");
          // Save the response BEFORE breaking — lastText is still the
          // previous (tool-only) iteration's text, so without this the
          // final answer is lost (reported text: "").
          lastText = textContent;
          finalAnswerAccepted = true;
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
            iterAuditRejection = true;
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
        finalAnswerAccepted = true;
        break;
      }
    }

    const tokensUsed = contextManager.getEstimatedTokens();
    const budget = contextManager.getBudget();
    const usageTokens = this.resolveUsageTokens(
      apiPromptTokens,
      apiCompletionTokens,
      estimatedPromptTokensTotal,
      apiCompletionChars,
    );

    if (iteration >= config.maxToolIterations && !finalAnswerAccepted) {
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
      totalCost: this.costTracker.total,
      costBreakdown: this.costTracker.breakdown(),
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
      totalCost: this.costTracker.total,
        costBreakdown: this.costTracker.breakdown(),
      compactionCount: contextManager.getCompactionCount(),
      contextQuality: contextManager.getQuality(),
      llmDurationMs: totalLlmDuration,
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
      maxCompletionTokens:
        config.provider.entries?.find((e) => e.label === config.provider.active)?.maxCompletionTokens ??
        config.provider.maxCompletionTokens,
    });
    this.deps.llmProvider = newProvider;
    this.deps.toolExecutor.updateProvider(newProvider);
    const newTokenCounter = new TokenCounter(config.model);
    this.deps.contextManager.resize(config.contextWindow, config.contextBudget, newTokenCounter);
    this.deps.config = config;
    if (this.deps.configRef) this.deps.configRef.current = config;
    this.costTracker.setModel(config.model);
  }

  setProvider(name: string, model?: string): void {
    const manager = new ProviderManager(this.deps.config.provider, {
      contextWindow: this.deps.config.contextWindow,
      retry: this.deps.config.retry,
      rateLimits: this.deps.config.security?.rateLimits,
      logger: this.deps.logger,
    });
    manager.switch(name, model);
    const providerCfg = manager.toConfig();
    this.deps.config.provider = providerCfg;
    this.deps.llmProvider = manager.active;
    this.deps.toolExecutor.updateProvider(manager.active);
    (this.deps.toolExecutor as any).ctx.llmProvider = manager.active;
  }

  listProviders(): Array<ProviderEntry & { label: string; active: boolean }> {
    const manager = new ProviderManager(this.deps.config.provider, {
      contextWindow: this.deps.config.contextWindow,
      retry: this.deps.config.retry,
      rateLimits: this.deps.config.security?.rateLimits,
    });
    const activeName = this.deps.config.provider.active;
    return manager.list().map((e) => ({
      ...e,
      active: e.label === activeName || e.type === activeName,
    }));
  }

  /** Build (or get cached) the provider for a named entry — health checks, routing. */
  getProviderFor(name: string): import("../llm/provider").LLMProvider | undefined {
    try {
      const manager = new ProviderManager(this.deps.config.provider, {
        contextWindow: this.deps.config.contextWindow,
        retry: this.deps.config.retry,
        rateLimits: this.deps.config.security?.rateLimits,
        logger: this.deps.logger,
      });
      manager.setModel(this.deps.config.model);
      manager.switch(name);
      return manager.active;
    } catch {
      return undefined;
    }
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
    // Note: do NOT close session log here — the session is still active.
    // Session log is closed only when the session actually ends (exit, session delete).
    pluginManager.runOnSessionEnd({
      logger,
      sessionManager: sessionManager?.getActiveMeta(),
      contextManager,
    });
  }
}
