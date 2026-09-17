import type { LLMProvider, ContentPart } from "../llm/provider";
import { ProviderManager } from "../modules/providers/manager";
import { buildActiveProvider } from "../modules/providers/factory";
import type { ToolExecutor } from "../tools/executor";
import type { PluginManager } from "../modules/plugins/manager";
import type { ContextManager, Message } from "../modules/context/manager";
import type { HallucinationDetector } from "../modules/hallucination/detector";
import type { Logger } from "../logger/app-logger";
import type { AppConfig, ProviderEntry } from "../config/types";
import type { ToolScope, ToolDefinition, ToolResult } from "../tools/types";
import type { PromptBlock } from "./types";
import type { EnvironmentReport } from "./environment";
import type { ToolCall, ToolEvent, AgentPhase, LLMResponse, AgentResult } from "./types";
import type { SessionManager } from "../modules/session/manager";
import type { ModuleRegistry } from "../modules/registry";
import { t } from "../i18n/index";
import { pc } from "../ui/colors";
import { join } from "path";
import { PromptBuilder } from "./prompt-builder";
import { processRegistry } from "../modules/processes";
import { SessionLogger } from "./session-logger";
import { runWithMoE } from "./agent-moe";
import { MemoryStore } from "../modules/memory/store";
import { CostTracker } from "../modules/pricing/index";
import { createPolicyState } from "../modules/reasoning/policy";
import type { PolicyState } from "../modules/reasoning/policy";
import type { ReasoningLevel } from "../config/types";
import type { ReasoningState } from "../tools/set-thinking";
import { estimateTokens } from "../llm/token-counter";
import { LlmError } from "../llm/llm-errors";
import { createLoopState, clearIterationSignals } from "./agent/loop-state";
import type { LoopState } from "./agent/loop-state";
import { CompactionService } from "./agent/compaction";
import { TokenTracker } from "./agent/token-tracker";
import { buildPromptSnapshot, diffPrompt } from "./agent/prefix-monitor";
import { ReasoningEffortResolver } from "./agent/reasoning-resolver";
import { ContextRenderer } from "./agent/context-renderer";
import { ToolBatchExecutor } from "./agent/tool-batch";
import { HallucinationGate } from "./agent/hallucination-gate";
import { AuditGate } from "./agent/audit-gate";
import {
  resolvePromptOverflow,
  overflowHint,
  HINT_BLOCK_TOKENS,
} from "./prompt-overflow";
import type { PromptBlockKind } from "./types";
import {
  MAX_EMPTY_RESPONSE_RETRIES,
  MAX_LLM_ERROR_RETRIES,
  MAX_REPEATED_TOOL_CALLS,
  MUTATION_CYCLE_NUDGE_THRESHOLD,
} from "./agent/constants";

export { toolOutputCharLimit, compactToolError } from "./agent/tool-output";

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
  /** Config directory — used for the "raise context window" hint in overflow warnings. */
  configDir?: string;
  /**
   * Compact plan status line for the <system-summary> envelope. Replaces the
   * dynamic plan block in the system prompt so the prompt stays immutable
   * (KV-cache friendly). Returns null when no plan is active.
   */
  planSummary?: () => string | null;
  /** Test seam — replaces the real runWithMoE (Bun module mocks are process-global). */
  runWithMoEOverride?: typeof runWithMoE;
}

/**
 * Ключ целевого объекта мутации для детекции «перфекционизм-цикла».
 * edit_file/write_file → путь файла; bash → нормализованная команда.
 * Остальные тула (read-only, bookkeeping) не считаются мутациями.
 * Внимание: в цикле toolCall.arguments — сырая JSON-строка от провайдера.
 */
export function mutationTargetKey(
  name: string,
  rawArgs: unknown,
): string | null {
  let a: Record<string, unknown> | null = null;
  if (typeof rawArgs === "string") {
    try {
      a = JSON.parse(rawArgs) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (rawArgs && typeof rawArgs === "object") {
    a = rawArgs as Record<string, unknown>;
  }
  if (!a) return null;
  if ((name === "edit_file" || name === "write_file") && typeof a.path === "string") {
    return `write:${a.path.replace(/\\/g, "/").toLowerCase()}`;
  }
  if (name === "bash" && typeof a.command === "string") {
    const cmd = a.command.replace(/\s+/g, " ").trim().slice(0, 80).toLowerCase();
    return cmd ? `bash:${cmd}` : null;
  }
  // Bookkeeping churn: plan/todo repeated over the same action with slightly
  // different args burned 10+ iterations in ses_mthn3c2a after an audit
  // rejection (the model "fixed" the plan instead of the work).
  if ((name === "plan" || name === "todo") && typeof a.action === "string") {
    return `book:${name}:${a.action.toLowerCase()}`;
  }
  return null;
}

export class Agent {
  private deps: AgentDeps;
  private systemPromptAdded = false;
  private shutdownRequested = false;
  private abortController: AbortController | null = null;
  private costTracker: CostTracker;
  /** Рендер UI-индикаторов контекста (stats-бар/компакция). Экземпляр
   * переживает несколько запусков цикла — хранит lastCompactionShown. */
  private contextRenderer: ContextRenderer;
  private policyState: PolicyState;
  /** Reasoning probe result (B2): starts from deps, refreshed lazily in run(). */
  private probePassed: boolean;
  /** Shared mutable reasoning state (owned by agent, shared with set_thinking tool). */
  readonly reasoningState: ReasoningState;
  /** Current iteration counter (exposed for tool cooldown checks). */
  private _currentIteration = 0;
  /** Kind → replacement block for instructions/project-map blocks that
   *  exceeded the system budget (resolved once before the first LLM call). */
  private promptOverrides = new Map<PromptBlockKind, PromptBlock>();
  /** Small always-included block explaining the compressed instructions. */
  private overflowHintBlock: PromptBlock | null = null;
  /** Guards the one-time async overflow resolution in run(). */
  private overflowResolved = false;

  constructor(deps: AgentDeps) {
    this.deps = deps;
    this.costTracker = new CostTracker(deps.config.model, deps.config.pricing);
    this.contextRenderer = new ContextRenderer();
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
    const p = this.deps.config.provider;
    let providerName = p?.type || "unknown";
    // When provider.entries exist, use the active entry's label for
    // distinguishable cost provenance (e.g. "lmstudio" vs "ollama").
    if (p?.entries && p.entries.length > 0) {
      const entry = p.active
        ? p.entries.find((e) => e.label === p.active || e.type === p.active)
        : p.entries[0];
      if (entry) providerName = entry.label || entry.type || providerName;
    }
    return { provider: providerName, model: this.deps.config.model };
  }

  /** Typed module accessor for CLI/REPL commands (e.g. /lsp). */
  getModule<T>(name: string): T | undefined {
    return this.deps.moduleRegistry?.get(name) as T | undefined;
  }

  /**
   * Запуск тула по имени из CLI/REPL (например, lsp_check). Обходит
   * инкапсуляцию: команды не должны лезть в приватные `deps`.
   */
  runTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return this.deps.toolExecutor.executeByName(name, args);
  }

  private setScope(): void {
    if (this.deps.scope) {
      this.deps.toolExecutor.setScope(this.deps.scope);
    }
  }

  private buildSystemPrompt(): {
    prompt: string;
    excluded: string[];
    excludedBlocks: PromptBlock[];
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
    // Overflow replacements (compressed instructions / project map) take
    // precedence over the original oversized blocks.
    const applyOverrides = (blocks: PromptBlock[]): PromptBlock[] =>
      blocks.map((b) => (b.kind && this.promptOverrides.has(b.kind) ? this.promptOverrides.get(b.kind)! : b));
    builder.addBlocks(applyOverrides(this.deps.promptBlocks));
    const dynamic = this.deps.getDynamicPromptBlocks?.() ?? [];
    if (dynamic.length > 0) {
      builder.addBlocks(applyOverrides(dynamic));
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
    if (this.overflowHintBlock) {
      builder.addBlock(this.overflowHintBlock);
    }
    const result = builder.build();
    return {
      prompt: result.prompt,
      excluded: result.excluded,
      excludedBlocks: result.excludedBlocks,
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
   * One-time (first run) handling of instructions/project-map blocks that did
   * not fit the system-prompt budget: they are summarized by the LLM into the
   * remaining budget (disk-cached) or truncated, and a small hint block tells
   * the model what happened and how to read the full source.
   */
  private async resolvePromptOverflowOnce(): Promise<void> {
    const cfg = this.deps.config;
    const dry = this.buildSystemPrompt();
    const overflow = dry.excludedBlocks.filter((b) => Boolean(b.kind));
    if (overflow.length === 0) return;

    const systemBudget = Math.floor(cfg.contextWindow * cfg.contextBudget.systemPrompt);
    const res = await resolvePromptOverflow({
      overflow,
      includedTokens: dry.blocks.filter((b) => b.included).reduce((s, b) => s + b.tokens, 0),
      systemBudget,
      provider: cfg.instructions?.summarize === false ? null : this.deps.llmProvider,
      cacheDir: join(this.deps.baseDir, ".mma", "cache", "prompt-summaries"),
      logger: this.deps.logger,
    });
    for (const r of res.replacements) {
      if (r.kind) this.promptOverrides.set(r.kind, r);
    }
    this.overflowHintBlock = res.hintBlock;

    const needed =
      dry.blocks.filter((b) => b.included).reduce((s, b) => s + b.tokens, 0) +
      overflow.reduce((s, b) => s + b.estimatedTokens, 0) +
      HINT_BLOCK_TOKENS;
    const hint = overflowHint(cfg, this.deps.configDir, needed);
    for (const w of res.warnings) {
      this.deps.logger.warn(
        t("prompt.overflow.exceeded", {
          label: w.label,
          original: String(w.originalTokens),
          budget: String(systemBudget),
          mode: w.mode === "summary" ? "summarized" : "truncated",
          resolved: String(w.resolvedTokens),
          hint,
        }),
      );
    }
  }

  private refreshSystemPrompt(): void {
    const { prompt } = this.buildSystemPrompt();
    const current = this.deps.contextManager.getActiveHistory().find((m) => m.role === "system");
    if (!current || current.content !== prompt) {
      this.deps.contextManager.updateSystemPrompt?.(prompt);
    }
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
      // One-time resolution of instructions/project-map blocks that exceed
      // the system-prompt budget: summarize (cached) or truncate them BEFORE
      // the first real build so the model still receives the instructions.
      if (!this.overflowResolved) {
        this.overflowResolved = true;
        try {
          await this.resolvePromptOverflowOnce();
        } catch (err: any) {
          this.deps.logger.warn(
            t("prompt.overflow.failed", { error: String(err?.message ?? err) }),
          );
        }
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
      const moeRunner = this.deps.runWithMoEOverride ?? runWithMoE;
      const result = moeEnabled
        ? await moeRunner(
            {
              config,
              llmProvider,
              toolExecutor,
              logger,
              baseDir: this.deps.baseDir,
            },
            input,
            () => this.executeSingleAgentLoop(input, slog, onChunk, onMeta, countTool, onPhase),
            {
              onMeta,
              onTool: countTool,
              onPhase,
              signal: this.abortController.signal,
              onEvent: (event) => slog.logMoE(event.type, event.data),
              sessionId: this.deps.sessionManager?.getActiveMeta()?.id,
            },
          )
        : await this.executeSingleAgentLoop(input, slog, onChunk, onMeta, countTool, onPhase);

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
    slog: SessionLogger,
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
    } = this.deps;

    this.abortController = new AbortController();
    // Единый контейнер состояния цикла — заменяет ~24 разрозненных `let`.
    const state = createLoopState();

    // Модули цикла: каждый инкапсулирует одну ответственность и получает
    // зависимости через конструктор (никаких глобальных синглтонов).
    const compactionService = new CompactionService({
      contextManager,
      logger,
      slog,
      hallucinationDetector,
    });
    const tokenTracker = new TokenTracker(this.costTracker, () => this.callerProvenance().provider);
    const reasoningResolver = new ReasoningEffortResolver();
    const toolBatch = new ToolBatchExecutor({
      config,
      toolExecutor,
      pluginManager,
      contextManager,
      hallucinationDetector,
      compactionService,
      logger,
      memoryStore: this.deps.memoryStore,
      costTracker: this.costTracker,
      planSummary: this.deps.planSummary,
      getAbortSignal: () => this.abortController?.signal,
      isShutdownRequested: () => this.shutdownRequested,
      setScope: () => this.setScope(),
    });
    const hallucinationGate = new HallucinationGate(hallucinationDetector);
    const auditGate = new AuditGate(this.deps.finalAudit);

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
      (sum, t) => sum + estimateTokens(t.description + JSON.stringify(t.parameters)),
      0,
    );
    contextManager.setToolTokens(toolTokenEstimate);

    while (state.iteration < config.maxToolIterations && !this.shutdownRequested) {
      state.iteration++;
      this._currentIteration = state.iteration;
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
        iteration: state.iteration,
        logger,
        lastUserMessage: input,
        contextManager,
        onMeta,
        sessionLog: {
          plan: (event: string, detail: string, iter?: number) => slog.logPlan(event, detail, iter),
        },
      });

      // Единая точка компакции: интервал → качество (с cooldown) → переполнение.
      compactionService.compactIfNeeded(state);

      this.refreshSystemPrompt();
      const history = contextManager.getActiveHistory();

      // Монитор стабильности префикса: считаем до запроса, пишем в llm_usage
      // после. Char-оценка (chars/4) достаточна — важна динамика ratio и
      // причина расхождения, а не абсолютная точность токенов.
      const promptSnapshot = buildPromptSnapshot(history, allToolsForBudget);
      state.prefixDelta = diffPrompt(state.prevPrompt, promptSnapshot, estimateTokens);
      state.prevPrompt = promptSnapshot;
      if (
        state.prefixDelta.cause === "system" ||
        state.prefixDelta.cause === "tools" ||
        state.prefixDelta.cause === "history" ||
        state.prefixDelta.cause === "volatile"
      ) {
        state.lastPrefixBreak = state.prefixDelta;
      }

      slog.logToolDefs(
        allToolsForBudget.length,
        allToolsForBudget.map((t) => t.name),
        state.iteration,
      );

      if (state.iteration === 1) {
        const { blocks } = this.buildSystemPrompt();
        this.logContextStat("start", state.iteration, slog, blocks);
      } else {
        this.logContextStat("iteration", state.iteration, slog);
      }

      let textContent = "";
      let reasoningContent = "";
      const toolCalls: ToolCall[] = [];
      let sawToolCall = false;
      let emittedReasoning = false;

      this.emitPhase(state.iteration, "thinking", onPhase);
      const llmStart = Date.now();
      const baseline = tokenTracker.beginIteration(state, contextManager.getEstimatedTokens());
      logger.logLLMRequest(config.model, history.length, input, "agent");

      // Оценка reasoning-effort на итерацию. Сигналы описывают события
      // ПРЕДЫДУЩЕЙ итерации (выставляются на retry-путях перед continue),
      // поэтому политика оценивается ДО очистки сигналов — иначе raise-ветка
      // недостижима.
      const reasoning = reasoningResolver.resolve({
        state,
        policyState: this.policyState,
        reasoningConfig: config.reasoning,
        probePassed: this.probePassed,
        reasoningStrategy: this.deps.reasoningStrategy,
        reasoningState: this.reasoningState,
      });

      // Очистка per-итерационных сигналов после потребления политикой.
      clearIterationSignals(state);

      if (reasoning.level) {
        slog.logReasoningControl({
          iteration: state.iteration,
          level: reasoning.level,
          strategy: reasoning.strategy,
          probePassed: this.probePassed,
          source: reasoning.source,
        });
        contextManager.thinkingLevel = reasoning.level;
      }

      try {
        for await (const chunk of llmProvider.chat(
          history,
          allToolsForBudget as ToolDefinition[],
          this.abortController?.signal,
          reasoning.level ? { reasoningEffort: reasoning.level, reasoningStrategy: reasoning.strategy } : undefined,
        )) {
          if (this.shutdownRequested) break;
          if (chunk.type === "text" && chunk.content) {
            if (emittedReasoning && !textContent) {
              onMeta?.("\n\n");
            }
            textContent += chunk.content;
            const textOut = pluginManager.runOnText({ iteration: state.iteration, logger, contextManager }, chunk.content);
            onChunk?.(textOut);
          }
          if (chunk.type === "reasoning" && chunk.content) {
            reasoningContent += chunk.content;
            if (config.showReasoning) {
              const metaOut = pluginManager.runOnMeta(
                { iteration: state.iteration, logger, contextManager },
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
            // chat() вызывается ОДИН раз за итерацию — каждый `done` здесь
            // относится к тому же логическому запросу (usage-only чанк +
            // non-streaming fallback дают два done). ЗАМЕНЯЕМ running-суммы
            // вместо аккумуляции, иначе один реальный запрос посчитается дважды.
            tokenTracker.recordApiUsage(state, baseline, chunk.usage);
          }
        }
      } catch (err: any) {
        if (this.shutdownRequested || err?.name === "AbortError") {
          logger.info("LLM call aborted (interrupt)");
          break;
        }
        // Восстановимые ошибки LLM (например, токен-лимит на середине
        // tool_call): отдаём локализованную причину обратно в контекст, чтобы
        // модель адаптировалась (разбить запись на куски) вместо смерти всей
        // сессии. Ограничено во избежание бесконечного цикла.
        if (err instanceof LlmError && err.recoverable && state.llmErrorRetries < MAX_LLM_ERROR_RETRIES) {
          state.iterRecoverableLlmError = true;
          state.llmErrorRetries++;
          logger.warn(
            `Recoverable LLM error, feeding back (${state.llmErrorRetries}/${MAX_LLM_ERROR_RETRIES}): ${err.message}`,
          );
          slog.logError(err.message);
          pluginManager.runOnError({ iteration: state.iteration, logger, contextManager }, err);
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
        pluginManager.runOnError({ iteration: state.iteration, logger, contextManager }, err);
        return {
          success: false,
          text: state.lastText,
          error: t("error.llm", { message: err.message }),
          iterationCount: state.iteration,
        };
      } finally {
        this.emitPhase(state.iteration, "done", onPhase);
      }

      // Совокупная длина ответа — метрики токенов остаются валидными, даже
      // когда бэкенд опускает `usage`.
      tokenTracker.addCompletionChars(state, (textContent || reasoningContent).length);

      logger.logLLMResponse(
        config.model,
        (textContent || reasoningContent).length,
        Date.now() - llmStart,
        undefined,
        "agent",
      );
      state.totalLlmDuration += Date.now() - llmStart;

      // Per-call лог usage + стоимость. llama.cpp в стриминге часто опускает
      // `usage` — фолбэк на локальные оценки (контекст + chars/4) с пометкой
      // источника: лог должен отличать реальные API-цифры от эвристики.
      tokenTracker.logUsage(
        state,
        baseline,
        textContent || reasoningContent,
        contextManager.getEstimatedTokens(),
        state.iteration,
        Date.now() - llmStart,
        slog,
      );

      if (this.shutdownRequested) {
        break;
      }

      let llmResponse: LLMResponse | null = null;
      if (sawToolCall) {
        llmResponse = { type: "tool_call", calls: toolCalls };
      } else if (textContent) {
        llmResponse = { type: "text", content: textContent };
      } else if (reasoningContent) {
        llmResponse = { type: "reasoning", content: reasoningContent };
      }
      pluginManager.runOnAfterThink({ iteration: state.iteration, logger, contextManager }, llmResponse);

      // Детекция повторных одинаковых тулов (структурная, не по ключевым
      // словам). Сигнал питает reasoning policy для понижения effort на рутине.
      if (sawToolCall) {
        const signature = toolCalls
          .map((tc) => `${tc.name}:${JSON.stringify(tc.arguments)}`)
          .join("|");
        if (signature && signature === state.lastToolSignature) {
          state.iterRepetitive = true;
          // Nudge fires in ALL modes: an identical (tool,args) repeat is a
          // wasted iteration — observed with qwen3.5-9b re-running the same
          // verification command back-to-back after the answer was already
          // in the result. The hard stop below stays exitOnComplete-only so
          // interactive sessions keep user control.
          logger.info(
            `Repeated identical tool call detected (iteration ${state.iteration}) — nudging model to finish or change approach`,
          );
          contextManager.addMessage({
            role: "user",
            content: `<system-summary>You just called the same tool with identical arguments. If the task is done, answer with a final text response NOW. If the command failed, try a different approach.</system-summary>`,
          });
          if (this.deps.exitOnComplete) {
            state.repeatedToolCount++;
            if (state.repeatedToolCount >= MAX_REPEATED_TOOL_CALLS) {
              logger.debug("Exit-on-complete: repeated identical tool call, stopping");
              break;
            }
          }
        } else {
          state.repeatedToolCount = 0;
        }
        state.lastToolSignature = signature;
      }

      // Детекция «перфекционизм-цикла»: многократные правки ОДНОГО файла или
      // запуски одной команды через не-подряд итерации (edit → build → read →
      // edit…). Аргументы каждый раз новые, поэтому подряд-детекция дубликатов
      // выше этот паттерн не видит. Nudge уходит ПОСЛЕ tool-результатов, чтобы
      // не ломать парность assistant(tool_calls) → tool(results).
      const cycleNudges: string[] = [];
      if (sawToolCall) {
        for (const tc of toolCalls) {
          const target = mutationTargetKey(tc.name, tc.arguments);
          if (!target) continue;
          const count = (state.toolTargetCounts.get(target) ?? 0) + 1;
          state.toolTargetCounts.set(target, count);
          if (
            count >= MUTATION_CYCLE_NUDGE_THRESHOLD &&
            !state.cycleNudgedKeys.has(target)
          ) {
            state.cycleNudgedKeys.add(target);
            cycleNudges.push(target);
          }
        }
      }

      if (sawToolCall) {
        const batch = await toolBatch.execute(
          state,
          toolCalls,
          boundedToolNames,
          textContent,
          reasoningContent,
          input,
          onTool,
          onMeta,
          slog,
        );
        if (batch.interrupted) {
          break;
        }

        if (cycleNudges.length > 0) {
          logger.info(
            `Perfectionism cycle detected (${cycleNudges.length} target(s) at ${MUTATION_CYCLE_NUDGE_THRESHOLD}+ mutations) — nudging model to finalize`,
          );
          contextManager.addMessage({
            role: "user",
            content: `<system-summary>You have already modified or re-run the same target many times (e.g. ${cycleNudges[0]}). If the latest output is correct, STOP polishing and answer with a final text response. More identical edits will not change the result.</system-summary>`,
          });
        }

        this.contextRenderer.render(this.deps.config.ui, contextManager, onMeta);

        // Тулы означают, что модель продолжила работать, а не переотвечает —
        // послабление на повтор после аудита больше не действует.
        state.suppressRepetitionRetry = false;
        continue;
      }

      const verdict = await hallucinationGate.evaluate({
        state,
        textContent,
        input,
        exitOnComplete: this.deps.exitOnComplete ?? false,
        hasFinalAudit: !!this.deps.finalAudit,
        logger,
        contextManager,
        onMeta,
        onChunk,
      });
      if (verdict.action === "block") {
        return {
          success: false,
          text: state.lastText,
          error: t("error.response_blocked", { reason: verdict.reason }),
          iterationCount: state.iteration,
        };
      }
      if (verdict.action === "retry") {
        continue;
      }
      if (verdict.action === "exit") {
        // lastText/finalAnswerAccepted уже выставлены вентилем.
        break;
      }
      // warn/accept → принятие ответа

      if (textContent) {
        contextManager.addMessage({ role: "assistant", content: textContent });
        if (config.session.autoSave) {
          slog.saveAssistantMessage(textContent);
        }
        slog.logAssistant(textContent, reasoningContent, undefined, state.iteration);
      }

      state.lastText = textContent;

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

      // Guard: пустой финальный ответ (текста нет, тулов нет — часто только
      // reasoning после компакции). Подталкиваем к реальному ответу вместо
      // молчаливого завершения с text: "".
      if (!textContent?.trim()) {
        if (state.emptyResponseRetries < MAX_EMPTY_RESPONSE_RETRIES) {
          state.emptyResponseRetries++;
          logger.warn(
            `Empty response on iteration ${state.iteration} (retry ${state.emptyResponseRetries}/${MAX_EMPTY_RESPONSE_RETRIES})`,
          );
          contextManager.addMessage({
            role: "user",
            content: `<system-summary>Your previous response was empty. Answer the user's task now with a final text response or call a tool. Do not reply with reasoning only.</system-summary>`,
          });
          continue;
        }
        state.emptyResponseExhausted = true;
        logger.warn(
          `Empty response retries exhausted after ${MAX_EMPTY_RESPONSE_RETRIES} attempts`,
        );
      }

      const auditVerdict = await auditGate.evaluate({
        state,
        iteration: state.iteration,
        maxIterations: config.maxToolIterations,
        logger,
        contextManager,
        slog,
      });
      if (auditVerdict === null || auditVerdict.action === "pass") {
        state.finalAnswerAccepted = true;
        break;
      }
      if (auditVerdict.action === "exhausted") {
        // auditFailed уже выставлен вентилем.
        break;
      }
      // reject → continue: аудит уже добавил контекст и взвёл suppressRepetitionRetry.
      continue;
    }

    const tokensUsed = contextManager.getEstimatedTokens();
    const budget = contextManager.getBudget();
    const usageTokens = tokenTracker.resolveFinal(state);
    const cacheStats = this.buildCacheStats(state);

    if (state.iteration >= config.maxToolIterations && !state.finalAnswerAccepted) {
      return {
        success: false,
        text: state.lastText,
        error: t("error.max_iters", { max: config.maxToolIterations }),
        iterationCount: state.iteration,
        contextUsed: tokensUsed,
        contextLimit: budget.history,
        promptTokens: usageTokens.prompt,
        completionTokens: usageTokens.completion,
        totalTokens: usageTokens.total,
        totalCost: this.costTracker.total,
        costBreakdown: this.costTracker.breakdown(),
        cache: cacheStats,
        compactionCount: contextManager.getCompactionCount(),
        contextQuality: contextManager.getQuality(),
      };
    }

    return {
      success: state.emptyResponseExhausted || state.auditFailed ? false : true,
      text: state.lastText,
      error: state.emptyResponseExhausted
        ? t("error.empty_response")
        : state.auditFailed
          ? t("error.audit_failed", { summary: state.lastAuditSummary })
          : undefined,
      iterationCount: state.iteration,
      contextUsed: tokensUsed,
      contextLimit: budget.history,
      promptTokens: usageTokens.prompt,
      completionTokens: usageTokens.completion,
      totalTokens: usageTokens.total,
      totalCost: this.costTracker.total,
      costBreakdown: this.costTracker.breakdown(),
      cache: cacheStats,
      compactionCount: contextManager.getCompactionCount(),
      contextQuality: contextManager.getQuality(),
      llmDurationMs: state.totalLlmDuration,
    };
  }

  /**
   * Собирает статистику кеша промпта за прогон: провайдерские токены (если
   * были) плюс client-side стабильность префикса. Возвращает undefined, когда
   * нет ни данных провайдера, ни префикс-монитора — чтобы не засорять вывод.
   */
  private buildCacheStats(state: LoopState): AgentResult["cache"] {
    const hasTokens =
      state.cacheCachedTotal > 0 || state.cacheUncachedTotal > 0 || state.cacheWriteTotal > 0;
    // Приоритет — последнему реальному разрыву, иначе состояние текущей
    // итерации (нормальная дописка / первая итерация).
    const prefix = state.lastPrefixBreak ?? state.prefixDelta;
    if (!hasTokens && prefix?.stableRatio === undefined) return undefined;
    const denom = state.cacheCachedTotal + state.cacheUncachedTotal;
    return {
      cachedTokens: state.cacheCachedTotal,
      uncachedTokens: state.cacheUncachedTotal,
      cacheWriteTokens: state.cacheWriteTotal,
      hitRate: denom > 0 ? state.cacheCachedTotal / denom : 0,
      saved: this.costTracker.saved,
      prefixStable: prefix?.stableRatio,
      prefixCause: prefix?.cause,
      source: state.cacheSource,
    };
  }

  clearContext(): void {
    this.deps.contextManager.clear();
    this.systemPromptAdded = false;
  }

  async reconfigure(config: AppConfig): Promise<void> {
    const { TokenCounter } = await import("../llm/token-counter");
    const { provider: newProvider } = buildActiveProvider(config, this.deps.logger, {
      getSessionId: () => this.deps.sessionManager?.getActiveMeta()?.id,
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
    const { manager, provider } = buildActiveProvider(this.deps.config, this.deps.logger, {
      getSessionId: () => this.deps.sessionManager?.getActiveMeta()?.id,
    });
    manager.switch(name, model);
    const providerCfg = manager.toConfig();
    this.deps.config.provider = providerCfg;
    this.deps.llmProvider = provider;
    this.deps.toolExecutor.updateProvider(provider);
  }

  listProviders(): Array<ProviderEntry & { label: string; active: boolean }> {
    const manager = new ProviderManager(this.deps.config.provider, {
      contextWindow: this.deps.config.contextWindow,
      retry: this.deps.config.retry,
      rateLimits: this.deps.config.security?.rateLimits,
      getSessionId: () => this.deps.sessionManager?.getActiveMeta()?.id,
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
        getSessionId: () => this.deps.sessionManager?.getActiveMeta()?.id,
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
      logger.info(t("env.killed_processes", { count: String(killed) }));
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
