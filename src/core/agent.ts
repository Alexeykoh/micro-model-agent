/** Агент: одиночный цикл (INIT→…→OUTPUT) и MoE-путь, бюджеты, гейты. */
import type { LLMProvider, ContentPart } from "../llm/provider";
import { ProviderManager, activeProviderEndpoint } from "../modules/providers/manager";
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
import type { ToolCall, ToolEvent, AgentPhase, LLMResponse, AgentResult, OnMeta } from "./types";
import type { SessionManager } from "../modules/session/manager";
import type { ModuleRegistry } from "../modules/registry";
import { t } from "../i18n/index";
import { errMsg } from "../utils";
import { resolveVerbosity } from "../ui/theme";
import { join } from "path";
import { projectMmaDir } from "../config/paths";
import { PromptBuilder } from "./prompt-builder";
import { processRegistry } from "../modules/processes";
import { SessionLogger } from "./session-logger";
import { runWithMoE } from "./agent-moe";
import type { MemoryStore } from "../modules/memory/store";
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
import type { ContextLogger } from "./agent/context-log";
import { recordArtifactWrite, testChurnFile } from "./agent/artifact-progress";
import { ReasoningEffortResolver } from "./agent/reasoning-resolver";
import { repairToolCallPairing } from "./agent/tool-pairing";
import { ContextRenderer } from "./agent/context-renderer";
import { ToolBatchExecutor } from "./agent/tool-batch";
import { HallucinationGate } from "./agent/hallucination-gate";
import { resolveArtifactStates } from "./agent/artifact-resolve";
import { AuditGate } from "./agent/audit-gate";
import { CriticGate, gatherTurnToolEvents } from "./agent/critic-gate";
import { seedToolTags } from "../tools/auto-tags";
import { CriticClient } from "../modules/critic/client";
import { buildCriticProvider } from "../modules/critic/provider";
import { CRITIC_READONLY_TOOLS } from "../modules/critic/tools";
import { buildEvidencePack, isWorkMutation } from "../modules/critic/evidence";
import {
  deriveSessionName,
  generateSessionTitle,
  type TitleChat,
} from "../modules/session/auto-name";
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
  MAX_REPEATED_TOOL_CALLS_INTERACTIVE,
  MUTATION_CYCLE_NUDGE_THRESHOLD,
} from "./agent/constants";

export { toolOutputCharLimit, compactToolError } from "./agent/tool-output";

/**
 * Read-only тулты-интроспекции. Повтор одного с теми же аргументами прогресса
 * не даст никогда, поэтому интерактивный цикл жёстко стопает после нескольких
 * повторов (наблюдалось: `session_info` в тугом цикле после готовой задачи).
 * Мутирующие — только nudge, чтобы легитимный edit/build/read-цикл не резать.
 */
const LOOP_PRONE_STATUS_TOOLS = new Set([
  "session_info",
  "process_list",
  "process_log",
  "file_info",
  "project_map",
]);

/** Зависимости агента: конфиг, провайдер, тулы, контекст, логгеры, швы. */
export interface AgentDeps {
  config: AppConfig;
  /**
   * Общий живой бокс конфига. `reconfigure` меняет и `config`, и
   * `configRef.current`, чтобы захваченные при bootstrap ссылки (toolCtx.config,
   * валидаторы) видели текущие настройки.
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
   * Блоки промпта, вычисляемые асинхронно (напр., стартовый LSP/tsc health-check).
   * Промис стартует при bootstrap и баннер не блокирует; `run()` ждёт его
   * перед первым системным промптом, чтобы модель получила baseline до первого
   * LLM-вызова. Ждёт только первый `run()`.
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
  /** Общий ToolContext (состояние скоупа: allowlist, онбординг). */
  toolCtx?: import("../tools/types").ToolContext;
  /** Opt-in git-style логгер контекста (--context-log). Null/undefined — выкл. */
  contextLogger?: ContextLogger;
  memoryStore?: MemoryStore;
  moduleRegistry?: ModuleRegistry;
  exitOnComplete?: boolean;
  envReport?: EnvironmentReport;
  /**
   * Прошёл ли механизм reasoning-effort валидацию пробой. Только стартовое
   * значение — живой итог даёт `reasoningProbe` (B2), который агент лениво
   * ждёт перед первым LLM-вызовом.
   */
  reasoningProbePassed?: boolean;
  /**
   * Резолвит фоновую reasoning-пробу. Потребляется лениво рядом с
   * `lazyPromptBlocks`, чтобы bootstrap не блокировался на round-trip пробы;
   * до резолва механизм считается НЕ прошедшим.
   */
  reasoningProbe?: () => Promise<boolean>;
  /** Стратегия выражения reasoning effort на этом провайдере. */
  reasoningStrategy?: import("../config/types").ReasoningStrategy;
  /** Каталог конфига — для хинта «подними окно контекста» в варнингах. */
  configDir?: string;
  /**
   * Компактная статус-строка плана для <system-summary>. Заменяет динамический
   * план-блок в системном промпте, чтобы промпт оставался иммутабельным
   * (дружелюбен KV-кешу). Null, если активного плана нет.
   */
  planSummary?: () => string | null;
  /** Тестовый шов — подменяет настоящий runWithMoE (моки Bun глобальны на процесс). */
  runWithMoEOverride?: typeof runWithMoE;
  /** Тестовый шов — подменяет настоящий verify критика (моки Bun глобальны). */
  criticOverride?: {
    verify: (pack: import("../modules/critic/types").EvidencePack, signal?: AbortSignal) => Promise<import("../modules/critic/types").CriticVerdict | null>;
  };
  /**
   * Живое имя активной записи провайдера. Нужно, т.к. прозрачный failover
   * (FallbackProvider) переключает активную запись менеджера без обновления
   * `config.provider.active`; провенанс/стоимость должны отражать реально
   * обслужившего провайдера.
   */
  getProviderName?: () => string;
}

/**
 * Идентичность модели/бэкенда, против которой гонялась context-probe (снимок
 * значений — см. `Agent.lastProbeIdentity`).
 */
interface ProbeIdentity {
  model: string;
  baseUrl: string;
  active?: string;
}

function probeIdentityOf(config: AppConfig): ProbeIdentity {
  return {
    model: config.model,
    baseUrl: activeProviderEndpoint(config.provider).baseUrl,
    active: config.provider?.active,
  };
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
  // Bookkeeping-churn: повторы plan/todo над тем же действием с чуть разными
  // аргументами сожгли 10+ итераций в ses_mthn3c2a после отклонения аудита
  // (модель «чинила» план вместо работы).
  if ((name === "plan" || name === "todo") && typeof a.action === "string") {
    return `book:${name}:${a.action.toLowerCase()}`;
  }
  // У plan_step нет action — ключ по status, чтобы повторные апдейты
  // били в тот же гард подряд-дубликатов.
  if (name === "plan_step" && typeof a.status === "string") {
    return `book:${name}:${a.status.toLowerCase()}`;
  }
  return null;
}

/**
 * Агент: владеет циклом, конфигом, стоимостью, гейтами. Состояние хода —
 * в LoopState, шаги — в extracted-модулях.
 */
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
  /** Итог reasoning-пробы (B2): старт из deps, лениво обновляется в run(). */
  private probePassed: boolean;
  /** Общее мутабельное reasoning-состояние (владелец — агент, делит с set_thinking). */
  readonly reasoningState: ReasoningState;
  /** Счётчик текущей итерации (для кулдаунов тулов). */
  private _currentIteration = 0;
  /** Kind → блок-замена для instructions/project-map сверх бюджета (резолв раз до первого LLM-вызова). */
  private promptOverrides = new Map<PromptBlockKind, PromptBlock>();
  /** Идентичность, против которой гонялась проба. Сравнение ПО ЗНАЧЕНИЮ: все
   *  write-пути мутят живой конфиг in place и передают ТОТ ЖЕ объект в
   *  `reconfigure` — сравнение объектов изменения бы не увидело. Сидируется
   *  в конструкторе (строки до мутаций). */
  private lastProbeIdentity: ProbeIdentity;
  /** Малый всегда-включённый блок про сжатые инструкции. */
  private overflowHintBlock: PromptBlock | null = null;
  /** Гард одноразового асинхронного резолва переполнения в run(). */
  private overflowResolved = false;

  constructor(deps: AgentDeps) {
    this.deps = deps;
    this.costTracker = new CostTracker(deps.config.model, deps.config.pricing);
    this.contextRenderer = new ContextRenderer();
    this.policyState = createPolicyState();
    this.probePassed = deps.reasoningProbePassed ?? false;
    this.lastProbeIdentity = probeIdentityOf(deps.config);
    const initialLevel = (deps.config.reasoning?.mode !== "auto" ? deps.config.reasoning?.mode : undefined) ?? "medium";
    this.reasoningState = { level: initialLevel, overrideIteration: -100 };
  }

  /** Менеджер контекста наружу (аттач картинок в REPL и др. прямой доступ). */
  get contextManager(): ContextManager {
    return this.deps.contextManager;
  }

  /** Текущий эффективный уровень reasoning. */
  get reasoningLevel(): ReasoningLevel {
    return this.reasoningState.level;
  }

  /** Ставит уровень reasoning (REPL/CLI). "auto" снимает ручной override. */
  setReasoningLevel(level: ReasoningLevel | "auto"): void {
    if (level === "auto") {
      this.reasoningState.manual = false;
      return;
    }
    this.reasoningState.level = level;
    this.reasoningState.manual = true;
  }

  /** Номер текущей итерации (для кулдаунов тулов). */
  get currentIteration(): number {
    return this._currentIteration;
  }

  /**
   * Провенанс вызывающего: живой провайдер и модель (для стоимости/логов).
   * @returns {provider, model} реально обслужившие вызов.
   */
  callerProvenance(): { provider: string; model: string } {
    // Сначала живое имя: sticky failover переключает активную запись
    // менеджера, не трогая config.provider.active.
    const live = this.deps.getProviderName?.();
    if (live) return { provider: live, model: this.deps.config.model };

    const p = this.deps.config.provider;
    let providerName = p?.type || "unknown";
    // При записях провайдера — метка активной, чтобы провенанс стоимости
    // различался (напр. "lmstudio" vs "ollama").
    if (p?.entries && p.entries.length > 0) {
      const entry = p.active
        ? p.entries.find((e) => e.label === p.active || e.type === p.active)
        : p.entries[0];
      if (entry) providerName = entry.label || entry.type || providerName;
    }
    return { provider: providerName, model: this.deps.config.model };
  }

  /** Типизированный доступ к модулям для CLI/REPL (напр. /lsp). */
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

  /**
   * Ставит (или снимает) терминальную prompt-поверхность для интерактивных
   * тулов. Делегирует исполнителю, чтобы общий ToolContext — тот, что реально
   * получают тулы — нёс тот же инстанс.
   */
  setPromptIO(io?: import("../tools/prompt-io").PromptIO): void {
    this.deps.toolExecutor.setPromptIO(io);
  }

  /**
   * Дописывает системный блок на текущий прогон (гайд онбординга).
   * Удаление по идентичности через `removePromptBlock`. Блоки читаются при
   * каждой `buildSystemPrompt`, эффект — со следующего хода.
   */
  pushPromptBlock(block: PromptBlock): void {
    this.deps.promptBlocks.push(block);
  }

  /** Убирает ранее запушенный блок (по ссылке). */
  removePromptBlock(block: PromptBlock): void {
    const i = this.deps.promptBlocks.indexOf(block);
    if (i >= 0) this.deps.promptBlocks.splice(i, 1);
  }

  /** Тестовый вид текущих блоков промпта. */
  getPromptBlocksForTest(): PromptBlock[] {
    return this.deps.promptBlocks;
  }

  /** Общий ToolContext (бросает, если bootstrap его не дал). */
  get toolContext(): import("../tools/types").ToolContext {
    if (!this.deps.toolCtx) throw new Error("toolCtx not provided to Agent");
    return this.deps.toolCtx;
  }

  /** Небросающийся вариант `toolContext` для опциональных/lifecycle-проверок. */
  tryToolContext(): import("../tools/types").ToolContext | undefined {
    return this.deps.toolCtx;
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
    // Замены переполнения (сжатые инструкции/карта) приоритетнее исходных
    // негабаритных блоков.
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
   * Пишет состояние контекста в лог сессии. Каждую итерацию — полный таймлайн
   * роста/компакции/состава; `start`-снимок дополнительно несёт разбивку
   * системных блоков (что, приоритеты, оценки, что срезал бюджет).
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

  /**
   * Текущий системный промпт с подсчётом токенов (для /sysprompt, диагностики).
   * @returns текст, число токенов, исключённые блоки.
   */
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
   * Одноразовая (первый прогон) обработка instructions/project-map сверх
   * бюджета: LLM суммаризирует в остаток (диск-кэш) или усекает, а малый
   * hint-блок говорит модели что случилось и как читать полный источник.
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
      cacheDir: join(projectMmaDir(this.deps.baseDir), "cache", "prompt-summaries"),
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
          needed: String(needed),
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

  /**
   * Прогоняет ход агента: MoE-путь или одиночный цикл, с автонеймингом сессии.
   * @param input сообщение пользователя; @param onChunk/onMeta/onTool/onPhase/onReasoning колбэки вывода;
   * @returns итог прогона.
   */
  async run(
    input: string,
    onChunk?: (chunk: string) => void,
    onMeta?: OnMeta,
    onTool?: (ev: ToolEvent) => void,
    onPhase?: (phase: AgentPhase) => void,
    onReasoning?: (reasoning: string) => void,
  ): Promise<AgentResult> {
    // Сброс флага shutdown от прошлого прерывания
    this.shutdownRequested = false;
    // Свежий контроллер на ход — MoE-путь полагается на него для Esc
    // (executeSingleAgentLoop пересоздаёт его же для одиночного пути).
    this.abortController = new AbortController();
    this.setScope();
    // P5 автосужение: детерминированно пред-посеваем теги тулов из сырого
    // сообщения ДО первого LLM-вызова (системный промпт + схемы тулов).
    // Только добавление — mid-session гранты enable_tools не снимаются.
    // Пропуск при выключенном сужении (enableOnDemand: false → все тулы).
    if (this.deps.config.tools?.enableOnDemand !== false && this.deps.toolTags) {
      const added = seedToolTags(this.deps.toolTags, input);
      if (added.length > 0) {
        this.deps.logger.debug(`Auto-narrowing: pre-seeded tool tags [${added.join(", ")}]`);
      }
    }
    const {
      config,
      llmProvider,
      toolExecutor,
      pluginManager,
      contextManager,
      logger,
      sessionManager,
    } = this.deps;

    const slog = new SessionLogger(sessionManager, logger, () => this.callerProvenance());

    if (sessionManager && !sessionManager.getActive()) {
      sessionManager.create();
      logger.debug(`Session started: ${sessionManager.getActive()}`);
    }

    const activeMeta = sessionManager?.getActiveMeta();
    const isFirstMessage = !!activeMeta && activeMeta.messageCount === 0;

    if (
      !this.systemPromptAdded &&
      !contextManager.getActiveHistory().some((m) => m.role === "system")
    ) {
      // Стартовую диагностику сессии (окружение, плагины, скиллы) — первой
      // записью в session.jsonl, чтобы файл был самоописываем для пост-анализа.
      // LSP-проба логируется отдельно из repl.ts (может завершиться позже).
      // Дедуп: logSessionStart проверяет существующий session_start от дублей.
      slog.logSessionStart({
        environment: this.deps.envReport as unknown as Record<string, unknown>,
      });

      const lazy = this.deps.lazyPromptBlocks ? await this.deps.lazyPromptBlocks() : [];
      if (lazy.length > 0) {
        this.deps.promptBlocks.push(...lazy);
      }
      // Одноразовый резолв instructions/project-map сверх бюджета: суммаризация
      // (кэш) или усечение ДО первой сборки, чтобы модель инструкции получила.
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
      // B2: ждём фоновую reasoning-пробу рядом с ленивыми блоками, чтобы ПЕРВЫЙ
      // LLM-вызов уже знал, держит ли бэкенд механизм (bootstrap больше не ждёт).
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

    // Новое сообщение — новый интервал компакции: итерации прошлого хода не
    // должны триггерить компакцию на итерации 1 этого (наблюдалось: ход 2
    // скомпактился на итерации 8, снеся только что присланную задачу с 40+ ходами).
    if (typeof contextManager.resetUserTurn === "function") {
      contextManager.resetUserTurn();
    }
    contextManager.addMessage({ role: "user", content: input });
    slog.logUser(input);

    if (isFirstMessage && activeMeta && sessionManager) {
      const meta = sessionManager.getActiveMeta();
      if (meta && (meta.nameSource ?? "default") !== "manual") {
        sessionManager.rename(meta.id, deriveSessionName(input), "auto");
        if (config.session.autoName !== false) {
          const chat: TitleChat = async (prompt, signal) => {
            let text = "";
            for await (const chunk of llmProvider.chat(
              [{ role: "user", content: prompt }],
              undefined,
              signal,
              { maxTokens: 48, reasoningEffort: "none" },
            )) {
              if (chunk.type === "text" && chunk.content) text += chunk.content;
            }
            return text;
          };
          void generateSessionTitle(input, chat)
            .then((title) => {
              if (!title) return;
              const cur = sessionManager.getActiveMeta();
              if (cur && cur.id === meta.id && (cur.nameSource ?? "default") === "auto") {
                sessionManager.rename(meta.id, title, "auto");
              }
            })
            .catch(() => {});
        }
      }
    }

    // Жизненный цикл хода для плагинов: считаем тул-события вне цикла,
    // onTurnEnd — ровно один раз (успех, ошибка или прерывание).
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
            () => this.executeSingleAgentLoop(input, slog, onChunk, onMeta, countTool, onPhase, onReasoning),
            {
              onMeta,
              onTool: countTool,
              onPhase,
              signal: this.abortController.signal,
              onEvent: (event) => slog.logMoE(event.type, event.data),
              sessionId: this.deps.sessionManager?.getActiveMeta()?.id,
            },
          )
        : await this.executeSingleAgentLoop(input, slog, onChunk, onMeta, countTool, onPhase, onReasoning);

      // В MoE-режиме одиночный цикл (единственный писатель ходов ассистента)
      // не бежит — без этого история схлопнется user→user между ходами, а в
      // session.jsonl не будет ответа. Пишем итог один раз и только когда MoE
      // реально вёл ход (фолбэк уже записал сам).
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
    onMeta?: OnMeta,
    onTool?: (ev: ToolEvent) => void,
    onPhase?: (phase: AgentPhase) => void,
    onReasoning?: (reasoning: string) => void,
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
    const tokenTracker = new TokenTracker(this.costTracker, () => this.callerProvenance());
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
    // Защита: частичные/легаси конфиги (тесты, старый config.json) могут не иметь
    // домена `critic` — считаем выключенным, а не роняем цикл.
    const criticConfig = {
      enabled: config.critic?.enabled ?? false,
      tools: config.critic?.tools ?? true,
      maxCalls: config.critic?.maxCalls ?? 4,
      maxRepairCycles: config.critic?.maxRepairCycles ?? 1,
      timeoutMs: config.critic?.timeoutMs ?? 15000,
    };
    // Phase 2: выделенные провайдер/модель, если настроены, иначе активный
    // провайдер (v1). Битый оверрайд — warn + фолбэк, никогда не молча.
    const criticProvider = buildCriticProvider(config.critic, config, this.deps.llmProvider, {
      logger,
      getSessionId: () => this.deps.sessionManager?.getActiveMeta()?.id,
    });
    const criticClient = new CriticClient({
      provider: criticProvider,
      timeoutMs: criticConfig.timeoutMs,
    });
    const criticGate = new CriticGate({
      enabled: criticConfig.enabled,
      maxCalls: criticConfig.maxCalls,
      maxRepairCycles: criticConfig.maxRepairCycles,
      verify: this.deps.criticOverride?.verify ?? ((pack, signal) =>
        criticClient.verify(pack, signal, {
          // Phase 2 read-only цикл: проверки бегут последовательно здесь (гейт
          // await'ится между пакетами тулов), через общий executor с read-only
          // allowlist — записи/shell недостижимы.
          runCheck: criticConfig.tools && this.deps.toolCtx
            ? async (tool, args) => {
                const res = await toolExecutor.executeByName(tool, args, {
                  ...this.deps.toolCtx!,
                  toolAllowlist: [...CRITIC_READONLY_TOOLS],
                });
                return { ok: res.success, output: res.output ?? "" };
              }
            : undefined,
        })),
      buildPack: (d) =>
        buildEvidencePack({
          task: d.task,
          planSummary: d.planSummary,
          toolEvents: d.toolEvents,
          baseDir: this.deps.baseDir,
        }),
      signal: this.abortController?.signal,
    });

    // Определения тулов учитываем в бюджете контекста (идут через body.tools, не messages).
    // Пересчитываем каждую итерацию, чтобы `enable_tools` (мутит общий
    // activeToolTags) мог растить видимый модели набор прямо в прогоне.
    // Привязка к итерации держит оценку бюджета и boundedOutput в синхроне
    // с реально отправляемым.
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

      // Перечитываем мутабельный набор тегов — вдруг вызывали enable_tools.
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
      // Позиционная нормализация истории перед отправкой: вклинившийся user
      // (step-gate/auto-advance плана) или осиротевший tool ломает контракт
      // OpenAI и даёт 400 у строгих провайдеров. Новые прогоны порядок не
      // портят (pendingMessages), проход лечит уже испорченные resume-истории.
      const history = repairToolCallPairing(contextManager.getActiveHistory());

      // Монитор стабильности префикса: считаем до запроса, пишем в llm_usage
      // после. Char-оценка (chars/4) достаточна — важна динамика ratio и
      // причина расхождения, а не абсолютная точность токенов.
      const promptSnapshot = buildPromptSnapshot(history, allToolsForBudget);
      state.prefixDelta = diffPrompt(state.prevPrompt, promptSnapshot, estimateTokens);
      state.prevPrompt = promptSnapshot;

      // Opt-in git-style context log: snapshot отправляемого контекста.
      if (this.deps.contextLogger) {
        try {
          this.deps.contextLogger.record(history, allToolsForBudget, {
            iteration: state.iteration,
            ts: new Date().toISOString(),
            systemTokens: estimateTokens(promptSnapshot.system),
            toolTokens: estimateTokens(promptSnapshot.tools),
            historyTokens: estimateTokens(promptSnapshot.history),
            totalTokens: contextManager.getEstimatedTokens(),
            contextWindow: config.contextWindow,
          });
        } catch {
          // Логирование контекста не должно ронять агент.
        }
      }
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
      let malformedToolArgs = 0;

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
              onReasoning?.("\n\n");
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
                onReasoning?.(metaOut);
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
              // Битый JSON аргументов раньше молча превращался в `{}` —
              // модель звала тул с пустыми параметрами и не понимала причины.
              // Логируем и сообщаем модели, чтобы она повторила вызов.
              parsedArgs = {};
              malformedToolArgs++;
              logger.diagnostic(
                "warn",
                `Invalid JSON in tool_call arguments for "${chunk.toolCall.name}" (${chunk.toolCall.arguments.length} chars) — passing {}`,
              );
              slog.logError(
                `tool_args_parse_error: tool="${chunk.toolCall.name}" tool_call_id="${chunk.toolCall.id}" chars=${chunk.toolCall.arguments.length}`,
              );
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
          if (chunk.type === "warning" && chunk.content) {
            // Нефатальное уведомление провайдера (напр., ответ срезан cap'ом).
            // Рендерим через текстовый стрим, чтобы легло после частичной строки,
            // не ломая markdown; в контекст/историю ассистента НЕ добавляем.
            logger.diagnostic("warn", `LLM warning: ${chunk.content}`);
            onChunk?.(`\n\n> ⚠️ ${chunk.content}\n`);
          }
        }
      } catch (err: any) {
        if (this.shutdownRequested || err?.name === "AbortError") {
          logger.diagnostic("info", "LLM call aborted (interrupt)");
          break;
        }
        // Восстановимые ошибки LLM (например, токен-лимит на середине
        // tool_call): отдаём локализованную причину обратно в контекст, чтобы
        // модель адаптировалась (разбить запись на куски) вместо смерти всей
        // сессии. Ограничено во избежание бесконечного цикла.
        if (err instanceof LlmError && err.recoverable && state.llmErrorRetries < MAX_LLM_ERROR_RETRIES) {
          state.iterRecoverableLlmError = true;
          state.llmErrorRetries++;
          logger.diagnostic(
            "warn",
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

      // Сообщаем модели, что её аргументы тула были невалидным JSON: иначе она
      // видит лишь «пустой» вызов и не знает, что нужно повторить корректно.
      if (malformedToolArgs > 0) {
        contextManager.addMessage({
          role: "user",
          content: `<system-summary>${malformedToolArgs} tool call(s) in your last response had invalid JSON arguments and were executed with empty parameters. Re-issue them with valid JSON.</system-summary>`,
        });
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

      // Аннотация вывода модели в context-log (reasoning/текст/tool_calls).
      // НЕ входит в отправляемый контекст — пишется отдельным [OUTPUT]-блоком.
      if (this.deps.contextLogger && (reasoningContent || textContent || toolCalls.length > 0)) {
        try {
          this.deps.contextLogger.recordOutput({
            iteration: state.iteration,
            ts: new Date().toISOString(),
            reasoning: reasoningContent || undefined,
            text: textContent || undefined,
            toolCalls: toolCalls.map((tc) => ({ name: tc.name, arguments: tc.arguments })),
          });
        } catch {
          // Логирование контекста не должно ронять агент.
        }
      }

      // Детекция повторных одинаковых тулов (структурная, не по ключевым
      // словам). Сигнал питает reasoning policy для понижения effort на рутине.
      if (sawToolCall) {
        const signature = toolCalls
          .map((tc) => `${tc.name}:${JSON.stringify(tc.arguments)}`)
          .join("|");
        if (signature && signature === state.lastToolSignature) {
          state.iterRepetitive = true;
          // Nudge во ВСЕХ режимах: идентичный (тул,аргументы) повтор — пустая
          // итерация (наблюдалось: qwen3.5-9b гонял ту же verify-команду подряд,
          // когда ответ уже был в результате). Мутирующие в интерактиве —
          // только nudge (контроль у пользователя); status-тулы, которым повтор
          // прогресса не даст никогда, — жёсткий стоп после нескольких повторов.
          logger.diagnostic(
            "info",
            `Repeated identical tool call detected (iteration ${state.iteration}) — nudging model to finish or change approach`,
          );
          contextManager.addMessage({
            role: "user",
            content: `<system-summary>You just called the same tool with identical arguments. If the task is done, answer with a final text response NOW. If the command failed, try a different approach.</system-summary>`,
          });
          state.repeatedToolCount++;
          // Жёсткий стоп — только для status-тулов, которые не могут
          // прогрессировать от повтора. Мутирующие/побочные тулы (например,
          // bash) остаются nudge-only: пользователь мог явно попросить
          // выполнить команду несколько раз, и обрыв дал бы пустой ответ.
          const allStatusTools = toolCalls.every((tc) => LOOP_PRONE_STATUS_TOOLS.has(tc.name));
          if (this.deps.exitOnComplete) {
            if (state.repeatedToolCount >= MAX_REPEATED_TOOL_CALLS && allStatusTools) {
              logger.debug("Exit-on-complete: repeated identical status tool call, stopping");
              break;
            }
          } else if (
            state.repeatedToolCount >= MAX_REPEATED_TOOL_CALLS_INTERACTIVE &&
            allStatusTools
          ) {
            logger.diagnostic(
              "warn",
              `Repeated identical status tool ${state.repeatedToolCount}× (iteration ${state.iteration}) — stopping to avoid an infinite loop`,
            );
            break;
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
          // Прогресс тест/спек-артефактов (обобщённо, по пути файла).
          if (
            (tc.name === "write_file" || tc.name === "edit_file") &&
            typeof tc.arguments.path === "string"
          ) {
            recordArtifactWrite(state.artifactChurn, tc.arguments.path);
          }
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
        for (const tc of toolCalls) {
          if (isWorkMutation(tc.name)) state.mutationsSinceCritic++;
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
          logger.diagnostic(
            "info",
            `Perfectionism cycle detected (${cycleNudges.length} target(s) at ${MUTATION_CYCLE_NUDGE_THRESHOLD}+ mutations) — nudging model to finalize`,
          );
          contextManager.addMessage({
            role: "user",
            content: `<system-summary>You have already modified or re-run the same target many times (e.g. ${cycleNudges[0]}). If the latest output is correct, STOP polishing and answer with a final text response. More identical edits will not change the result.</system-summary>`,
          });
        }

        // Тест/спек-churn: серия правок тестов без единой production-правки
        // (обобщённо — см. artifact-progress.ts).
        const churnFile = testChurnFile(state.artifactChurn);
        if (churnFile) {
          state.artifactChurn.nudged = true;
          logger.diagnostic(
            "info",
            `Test/spec artifact churn: "${churnFile}" repeatedly edited with no production changes — nudging to implement or change approach`,
          );
          contextManager.addMessage({
            role: "user",
            content: `<system-summary>${t("exec.test_churn_nudge", { file: churnFile })}</system-summary>`,
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
        // Строка о неуверенности — диагностика: только verbose-режим.
        verbose: resolveVerbosity(this.deps.config.ui) === "verbose",
        // Заземление заявлений на диск (отсутствующие/непарсящиеся файлы,
        // поданные как созданные/валидные). Резолвится здесь — у гейта нет fs.
        artifacts: resolveArtifactStates(this.deps.baseDir, textContent),
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
          logger.diagnostic(
            "warn",
            `Empty response on iteration ${state.iteration} (retry ${state.emptyResponseRetries}/${MAX_EMPTY_RESPONSE_RETRIES})`,
          );
          contextManager.addMessage({
            role: "user",
            content: `<system-summary>Your previous response was empty. Answer the user's task now with a final text response or call a tool. Do not reply with reasoning only.</system-summary>`,
          });
          continue;
        }
        state.emptyResponseExhausted = true;
        logger.diagnostic(
          "warn",
          `Empty response retries exhausted after ${MAX_EMPTY_RESPONSE_RETRIES} attempts`,
        );
      }

      const criticAction = await criticGate.evaluate({
        state,
        iteration: state.iteration,
        logger,
        contextManager,
        slog,
        task: input,
        planSummary: this.deps.planSummary?.() ?? undefined,
        toolEvents: gatherTurnToolEvents(contextManager),
        beforeFinish: true,
      });
      if (criticAction === "retry") {
        state.suppressRepetitionRetry = true;
        continue;
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
      success: !(state.emptyResponseExhausted || state.auditFailed || state.retryLoopStopped),
      text: state.lastText,
      error: state.emptyResponseExhausted
        ? t("error.empty_response")
        : state.auditFailed
          ? t("error.audit_failed", { summary: state.lastAuditSummary })
          : state.retryLoopStopped
            ? t("error.retry_loop_stopped", { count: state.consecutiveFailedBatches })
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

  /** Сбрасывает контекст (следующий прогон пересоберёт системный промпт). */
  clearContext(): void {
    this.deps.contextManager.clear();
    this.systemPromptAdded = false;
  }

  /**
   * Применяет новый конфиг живьём: provider-first проба контекста, пересборка
   * провайдера, ресайз бюджетов, обновление стоимости.
   * @param config новый конфиг приложения.
   */
  async reconfigure(config: AppConfig): Promise<void> {
    const { TokenCounter } = await import("../llm/token-counter");
    // Provider-first контекст: при смене модели/бэкенда спрашиваем новый
    // провайдер о реально отдаваемом окне ДО пересборки бюджетов вокруг
    // (возможно протухшего) настроенного значения. Ручные правки
    // `contextWindow` без смены идентичности уважаются как есть.
    // Fail-open: ошибки пробы хранят настроенное значение.
    try {
      const nextId = probeIdentityOf(config);
      const prevId = this.lastProbeIdentity;
      const identityChanged =
        prevId.model !== nextId.model ||
        prevId.baseUrl !== nextId.baseUrl ||
        prevId.active !== nextId.active;
      if (identityChanged) {
        const nextEndpoint = activeProviderEndpoint(config.provider);
        const { probeModel, probeProviderContext } = await import("../llm/model-loader");
        const lmProbe = await probeModel(nextEndpoint.baseUrl, config.model);
        const detected =
          (lmProbe ? { model: lmProbe.model, actual: lmProbe.contextLength } : null) ??
          (await probeProviderContext(nextEndpoint.baseUrl, config.model, {
            apiKey: nextEndpoint.apiKey,
            providerType: nextEndpoint.type,
          }));
        if (detected && detected.actual !== config.contextWindow) {
          this.deps.logger?.info(
            `Context probe: auto-set contextWindow from provider — model "${detected.model}" serves ${detected.actual} tokens (configured was ${config.contextWindow}).`,
          );
          config.contextWindow = detected.actual;
        }
        this.lastProbeIdentity = nextId;
      }
    } catch {
      // Проба — best-effort, переключение модели/провайдера не блокируем никогда.
    }
    const built = buildActiveProvider(config, this.deps.logger, {
      getSessionId: () => this.deps.sessionManager?.getActiveMeta()?.id,
    });
    const newProvider = built.provider;
    this.deps.llmProvider = newProvider;
    this.deps.getProviderName = () => built.manager.activeName;
    this.deps.toolExecutor.updateProvider(newProvider);
    const newTokenCounter = new TokenCounter(config.model);
    this.deps.contextManager.resize(config.contextWindow, config.contextBudget, newTokenCounter);
    this.deps.config = config;
    if (this.deps.configRef) this.deps.configRef.current = config;
    this.costTracker.setModel(config.model);
  }

  /**
   * Переключает активного провайдера (и модель опционально).
   * @param name имя записи провайдера; @param model новая модель.
   */
  setProvider(name: string, model?: string): void {
    const { manager, provider } = buildActiveProvider(this.deps.config, this.deps.logger, {
      getSessionId: () => this.deps.sessionManager?.getActiveMeta()?.id,
    });
    manager.switch(name, model);
    const providerCfg = manager.toConfig();
    this.deps.config.provider = providerCfg;
    this.deps.llmProvider = provider;
    this.deps.getProviderName = () => manager.activeName;
    this.deps.toolExecutor.updateProvider(provider);
  }

  /**
   * Список записей провайдеров с флагом активности.
   * @returns записи с label и active.
   */
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

  /** Строит (или берёт кэшированный) провайдер именованной записи — health-чеки, роутинг. */
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
    } catch (err) {
      this.deps.logger.warn(t("error.provider_build", { name, error: errMsg(err) }));
      return undefined;
    }
  }

  /**
   * Заменяет контекст историей (resume): системный промпт + сообщения без дубля system.
   * @param messages сообщения для восстановления.
   */
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

  /**
   * Останавливает прогон: abort, kill фоновых процессов, onSessionEnd.
   * Лог сессии НЕ закрываем — сессия ещё активна (закрытие только на
   * реальном конце: exit, delete).
   */
  shutdown(): void {
    this.shutdownRequested = true;
    this.abortController?.abort();
    const { pluginManager, logger, sessionManager, contextManager } = this.deps;
    contextManager.onCompact = null;
    const killed = processRegistry.killAll();
    if (killed > 0) {
      logger.info(t("env.killed_processes", { count: String(killed) }));
    }
    // Сессионный лог тут НЕ закрываем — сессия ещё активна.
    // Закрытие только на реальном конце (exit, удаление сессии).
    pluginManager.runOnSessionEnd({
      logger,
      sessionManager: sessionManager?.getActiveMeta(),
      contextManager,
    });
  }
}
