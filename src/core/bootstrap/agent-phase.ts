/**
 * Фаза 6 bootstrap: сборка Agent.
 *
 * Порядок 1:1 с исходником: AgentDeps (статика + динамические блоки + ленивый
 * health-check + пробы) → `new Agent` → поздний резолв context-probe
 * (reconfigure под окно провайдера) → регистрация тула set_thinking.
 */
import { Agent } from "../agent";
import type { AgentDeps } from "../agent";
import type { AppConfig, ReasoningStrategy } from "../../config/types";
import type { Logger } from "../../logger/app-logger";
import type { LLMProvider } from "../../llm/provider";
import type { ProviderManager } from "../../modules/providers/manager";
import type { ToolExecutor } from "../../tools/executor";
import type { PluginManager } from "../../modules/plugins/manager";
import type { ContextManager } from "../../core/context/manager";
import type { SessionManager } from "../../modules/session/index";
import type { ToolContext } from "../../tools/types";
import { admissionDiagnosticSink } from "./tool-context";
import type { PromptBlock } from "../types";
import type { ContextProbeResult } from "../../llm/model-loader";
import type { MemoryStore } from "../../modules/memory/store";
import type { ModuleRegistry } from "../../modules/registry";
import type { ToolRegistry } from "../../tools/index";
import type { ExecutionModule } from "../../modules/execution/module";
import type { HallucinationDetector } from "../../core/hallucination/detector";
import type { ContextLogger } from "../agent/context-log";
import type { EnvironmentReport } from "../environment";
import { applyProbedContext } from "./provider-phase";
import { registerOwnedTools } from "../module-host";
import type { SilentLogger } from "./state";

/** Вход фазы сборки — все ранее собранные части плюс окружение агента. */
export interface AgentPhaseInput {
  /** Живой конфиг. */
  config: AppConfig;
  /** Общий бокс живого конфига (reconfigure меняет ссылку для всех). */
  configRef: { current: AppConfig };
  /** Живой LLM-провайдер. */
  llmProvider: LLMProvider;
  /** Менеджер провайдеров (имя активного для provenance). */
  providerManager: ProviderManager;
  /** Исполнитель тулов. */
  toolExecutor: ToolExecutor;
  /** Менеджер плагинов. */
  pluginManager: PluginManager;
  /** Менеджер контекста. */
  contextManager: ContextManager;
  /** Детектор галлюцинаций. */
  hallucinationDetector: HallucinationDetector;
  /** Настроенный логгер. */
  logger: Logger;
  /** Workspace. */
  baseDir: string;
  /** Каталог конфига. */
  configDir: string;
  /** Активные теги тулов (мутабельный набор цикла). */
  activeToolTags: string[];
  /** Статичные промпт-блоки первой сборки. */
  promptBlocks: PromptBlock[];
  /** Отчёт окружения (в deps агента). */
  envReport: EnvironmentReport;
  /** Динамические промпт-блоки каждой итерации. */
  getDynamicPromptBlocks: () => PromptBlock[];
  /** Ленивый стартовый health-check. */
  lazyPromptBlocks: () => Promise<PromptBlock[]>;
  /** Менеджер сессий. */
  sessionManager: SessionManager;
  /** Общее хранилище памяти. */
  memoryStore: MemoryStore;
  /** Реестр модулей. */
  moduleRegistry: ModuleRegistry;
  /** Владелец жизненного цикла модулей (dispose на завершении). */
  moduleHost?: import("../module-host").ModuleHost;
  /** Флаг выхода на первом ответе. */
  exitOnComplete: boolean | undefined;
  /** Git-style лог контекста. */
  contextLogger: ContextLogger | undefined;
  /** Фоновая reasoning-probe (лениво потребляется агентом). */
  reasoningProbePromise: Promise<boolean>;
  /** Стратегия reasoning из пресета провайдера. */
  reasoningStrategy: ReasoningStrategy;
  /** Владелец состояния плана. */
  execModule: ExecutionModule;
  /** Общий ToolContext. */
  toolCtx: ToolContext;
  /** Фоновая context-probe (поздний reconfigure). */
  contextProbePromise: Promise<ContextProbeResult | null>;
}

/**
 * Собирает AgentDeps, создаёт агента, применяет позднюю пробу и
 * регистрирует set_thinking.
 * @param input все собранные частями прошлых фаз.
 * @param toolRegistry реестр для регистрации set_thinking.
 * @returns готовый агент.
 */
export async function assembleAgent(
  input: AgentPhaseInput,
  toolRegistry: ToolRegistry,
): Promise<Agent> {
  const {
    config,
    configRef,
    llmProvider,
    providerManager,
    toolExecutor,
    pluginManager,
    contextManager,
    hallucinationDetector,
    logger,
    baseDir,
    configDir,
    activeToolTags,
    promptBlocks,
    envReport,
    getDynamicPromptBlocks,
    lazyPromptBlocks,
    sessionManager,
    memoryStore,
    moduleRegistry,
    moduleHost,
    exitOnComplete,
    contextLogger,
    reasoningProbePromise,
    reasoningStrategy,
    execModule,
    toolCtx,
    contextProbePromise,
  } = input;

  // Fail-open верификатора плана (INV-15/W0.6): `verify_error` пишем в session.jsonl
  // тем же путём, что и `sessionLog.plan` (SessionLogger создаётся внутри `Agent.run`,
  // поэтому здесь пишем напрямую через менеджер сессий).
  execModule.setDiagnosticSink((event, diag) => {
    sessionManager.appendLog({
      ts: new Date().toISOString(),
      type: event,
      content: diag.cause ?? diag.operation,
      source: diag.source,
      operation: diag.operation,
      errorKind: diag.kind,
      cause: diag.cause,
      recoverable: diag.recoverable,
    });
  });

  const agentDeps: AgentDeps = {
    config,
    configRef,
    llmProvider,
    getProviderName: () => providerManager.activeName,
    toolExecutor,
    pluginManager,
    contextManager,
    hallucinationDetector,
    logger,
    baseDir,
    configDir,
    toolTags: activeToolTags,
    promptBlocks,
    envReport,
    getDynamicPromptBlocks,
    finalAudit: () => execModule.runFinalAudit(),
    lazyPromptBlocks,
    sessionManager,
    memoryStore,
    moduleRegistry,
    moduleHost,
    exitOnComplete,
    contextLogger,
    reasoningProbe: () => reasoningProbePromise,
    reasoningStrategy,
    planSummary: () => execModule.getPlanSummary(),
    toolCtx,
    // INV-15: деградации проверки заявлений идут в сессию тем же стоком,
    // что и прочие сигналы петли.
    onDiagnostic: admissionDiagnosticSink(sessionManager),
  };

  const agent = new Agent(agentDeps);

  // Поздний резолв пробы: окно могло попасть в `config` после сборки
  // ContextManager/провайдера — один reconfigure, чтобы бюджеты и провайдер
  // его реально использовали. No-op, если проба села рано (то же значение)
  // или ход уже был.
  // Поздний резолв пробы: окно могло попасть в `config` после сборки
  // ContextManager/провайдера — нужен reconfigure, чтобы бюджеты реально
  // использовали probe. No-op, если проба цель ранняя (в окне) или ход уже был.
  // При применении обновляем env-снимок, чтобы session_start не показывал
  // до-пробное окно (наблюдалось: env 32768 при эффективном 34048).
  void contextProbePromise
    .then(async (probe) => {
      if (!probe) return;
      const applied = await applyProbedContext(
        agent,
        config,
        probe,
        logger as SilentLogger,
        sessionManager,
      );
      if (applied && envReport.provider) {
        envReport.provider.contextWindow = config.contextWindow;
        envReport.provider.model = config.model;
      }
    })
    .catch(() => {});

  // Тул set_thinking (нужен общее reasoning-состояние агента)
  if (config.reasoning) {
    const { createSetThinkingTool } = await import("../../tools/set-thinking");
    const setThinkingTool = createSetThinkingTool(
      agent.reasoningState,
      config.reasoning,
      () => agent.currentIteration,
    );
    registerOwnedTools(toolRegistry, [{ tool: setThinkingTool, owner: "core" }]);
  }

  return agent;
}
