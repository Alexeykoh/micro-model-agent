/**
 * Зависимости агента (`AgentDeps`) и сток диагностик петли (INV-15).
 * Вынесено из `core/agent.ts`, чтобы модули фаз не тянули класс агента.
 */
import type { LLMProvider } from "../../llm/provider";
import type { ToolExecutor } from "../../tools/executor";
import type { PluginManager } from "../../modules/plugins/manager";
import type { ContextManager } from "../context/manager";
import type { HallucinationDetector } from "../hallucination/detector";
import type { Logger } from "../../logger/app-logger";
import type { AppConfig } from "../../config/types";
import type { ToolScope } from "../../tools/types";
import type { PromptBlock } from "../types";
import type { EnvironmentReport } from "../environment";
import type { SessionManager } from "../../modules/session/manager";
import type { ModuleRegistry } from "../../modules/registry";
import type { MemoryStore } from "../../modules/memory/store";
import type { ContextLogger } from "./context-log";
import type { Diagnostic } from "../../output/types";

/** Сток диагностик fail-open (INV-15). */
export type DiagnosticSink = (diag: Diagnostic) => void;

/**
 * Общий бокс ЖИВЫХ проб провайдера (INV-R2): capabilities-discovery + ленивая
 * reasoning-проба. Один объект на main-агента, раннеры и субагентов — иначе
 * свитч провайдера обновляет данные только у того, кто их перепробил.
 */
export interface ProviderProbesBox {
  probe?: import("../../config/types").ModelCapabilities;
  /** Проба поддержки reasoning для ТЕКУЩЕЙ пары провайдер+модель (B2). */
  reasoningProbe?: () => Promise<boolean>;
}

/** Живой итог context-probe: `undefined` — ещё не устоялась, `null` — не удалось. */
export interface ContextProbeBox {
  current?: import("../../llm/provider-context").ContextProbeResult | null;
}

/** Зависимости агента: конфиг, провайдер, тулы, контекст, логгеры, швы. */
export interface AgentDeps {
  config: AppConfig;
  /** Живой бокс конфига: `reconfigure` меняет и его, и `configRef.current`. */
  configRef?: { current: AppConfig };
  llmProvider: LLMProvider;
  toolExecutor: ToolExecutor;
  pluginManager: PluginManager;
  contextManager: ContextManager;
  hallucinationDetector: HallucinationDetector;
  logger: Logger;
  /** Сток fail-open петли (INV-15); ставится bootstrap-фазой. */
  onDiagnostic?: DiagnosticSink;
  /** Per-call usage прогона: субагент отдаёт его в журнал сессии (`subagent`-записи). */
  onUsage?: (usage: import("../../tools/subagent-runs").SubagentUsageRecord) => void;
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
  toolCtx?: import("../../tools/types").ToolContext;
  /** Opt-in git-style логгер контекста (--context-log). Null/undefined — выкл. */
  contextLogger?: ContextLogger;
  memoryStore?: MemoryStore;
  moduleRegistry?: ModuleRegistry;
  /** Владелец жизненного цикла модулей: `dispose()` (teardown) на завершении. */
  moduleHost?: import("../module-host").ModuleHost;
  exitOnComplete?: boolean;
  envReport?: EnvironmentReport;
  /**
   * Прошёл ли механизм reasoning-effort валидацию пробой. Только стартовое
   * значение — живой итог даёт `reasoningProbe` (B2), который агент лениво
   * ждёт перед первым LLM-вызовом.
   */
  reasoningProbePassed?: boolean;
  /** Резолвит фоновую reasoning-пробу лениво (рядом с `lazyPromptBlocks`), чтобы
   * bootstrap не блокировался на round-trip; до резолва механизм НЕ прошедший. */
  reasoningProbe?: () => Promise<boolean>;
  /** Стратегия выражения reasoning effort на этом провайдере. */
  reasoningStrategy?: import("../../config/types").ReasoningStrategy;
  /** Объявленные эндпоинтом уровни effort (тот же резолв, что стратегия). */
  reasoningLevels?: string[];
  /**
   * Живая проба возможностей (INV-R2): пересборка провайдера при `reconfigure`
   * и смене модели обязана видеть те же discovery-данные, что и bootstrap,
   * иначе экземпляр откатывается к пресету и молча теряет `reasoning_effort`.
   * Общий бокс: его обновляет основной агент, читают раннеры/субагенты.
   */
  capabilitiesProbeRef?: ProviderProbesBox;
  /** Живой бокс context-probe для веб-сайдбара: свитч провайдера обновляет его
   *  сразу, а не оставляет снимок bootstrap-промиса. */
  contextProbeRef?: ContextProbeBox;
  /** Каталог конфига — для хинта «подними окно контекста» в варнингах. */
  configDir?: string;
  /**
   * Компактная статус-строка плана для <system-summary>. Заменяет динамический
   * план-блок в системном промпте, чтобы промпт оставался иммутабельным
   * (дружелюбен KV-кешу). Null, если активного плана нет.
   */
  planSummary?: () => string | null;
  /**
   * Незакрытые шаги плана (S5) — улика для критика, что работа не завершена.
   * Те же критерии `isUnconfirmed`, что у финального аудита.
   */
  planPendingSteps?: () => string[];
  /** Тестовый шов — подменяет настоящий verify критика (моки Bun глобальны). */
  criticOverride?: {
    verify: (pack: import("../../modules/critic/types").EvidencePack, signal?: AbortSignal) => Promise<import("../../modules/critic/types").CriticVerdict | null>;
  };
  /**
   * Живое имя активной записи провайдера. Нужно, т.к. прозрачный failover
   * (FallbackProvider) переключает активную запись менеджера без обновления
   * `config.provider.active`; провенанс/стоимость должны отражать реально
   * обслужившего провайдера.
   */
  getProviderName?: () => string;
}
