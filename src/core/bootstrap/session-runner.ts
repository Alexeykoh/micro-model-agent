/**
 * Фабрика per-session раннеров для настоящего параллелизма (`mma web`).
 *
 * Один `Agent` — не reentrant (abort/shutdown/итерации/контекст — поля
 * инстанса), а ContextManager/SessionManager/ExecutionModule держат одну
 * активную сессию на процесс. Поэтому каждая одновременно бегущая сессия
 * получает СВОЙ раннер: агент + контекст + запиненный менеджер сессий +
 * трекер плана + исполнитель тулов. Разделяются только stateless/длинноживущее:
 * конфиг, провайдер, реестр-шаблон, инстансы плагинов, память, индекс.
 *
 * Прецедент изоляции — тул `subagent` (свой ContextManager/PluginManager/
 * HallucinationDetector поверх shared executor/provider); параллельные
 * сабагенты уже гоняют тулы конкурентно через общий исполнитель.
 */
import { join } from "path";
import { Agent } from "../agent";
import type { AgentDeps } from "../agent";
import type { AppConfig, ReasoningStrategy, ModelCapabilities } from "../../config/types";
import type { Logger } from "../../logger/app-logger";
import type { LLMProvider } from "../../llm/provider";
import type { ProviderManager } from "../../modules/providers/manager";
import { ContextManager } from "../../modules/context/manager";
import { TokenCounter } from "../../llm/token-counter";
import type { SessionManager } from "../../modules/session/index";
import { SessionModule } from "../../modules/session/module";
import { ExecutionModule } from "../../modules/execution/module";
import { HallucinationDetector } from "../../modules/hallucination/detector";
import type { ToolExecutor } from "../../tools/executor";
import type { ToolRegistry } from "../../tools/registry";
import type { PluginManager } from "../../modules/plugins/manager";
import type { DraftHost } from "../../modules/plugins/drafts";
import type { ToolContext } from "../../tools/types";
import type { PromptBlock } from "../types";
import type { MemoryStore } from "../../modules/memory/store";
import type { ModuleRegistry } from "../../modules/registry";
import type { ContextProbeResult } from "../../llm/model-loader";
import type { EnvironmentReport } from "../environment";
import { ContextLogger } from "../agent/context-log";
import { createSetThinkingTool } from "../../tools/set-thinking";
import { buildActiveProvider } from "../../modules/providers/factory";
import { activeProviderEndpoint } from "../../modules/providers/manager";
import { applyProbedContext } from "./provider-phase";
import type { SilentLogger } from "./state";
import {
  buildRunnerDynamicBlocks,
  buildRunnerExecutor,
  buildRunnerPlugins,  buildRunnerRegistry,
  buildRunnerToolCtx,
} from "./session-runner-scope";

/** Готовый к ходу раннер одной сессии. */
export interface SessionRunner {
  sessionId: string;
  agent: Agent;
  contextManager: ContextManager;
  sessionManager: SessionManager;
  toolExecutor: ToolExecutor;
  toolCtx: ToolContext;
  execModule: ExecutionModule;
  pluginManager: PluginManager;
  registry: ToolRegistry;
  contextLogger: ContextLogger | undefined;
  /**
   * Отпустить ресурсы раннера (сейчас — снять его реестр с вклада тулов
   * плагинов). Вызывается пулом при удалении сессии и при остановке сервера:
   * иначе менеджер плагинов держал бы реестр выключенной вкладки и вносил бы
   * в него тулы после перезагрузки.
   */
  dispose?(): void;
}

/**
 * Всё долгоживущее, нужное для спавна (снимок фаз bootstrap; мутабельное —
 * только через shared ссылки, как у main-агента).
 */
export interface SessionRunnerTemplate {
  config: AppConfig;
  configRef: { current: AppConfig };
  logger: Logger;
  baseDir: string;
  configDir: string;
  /** Шаблон статичных промпт-блоков (раннер берёт копию). */
  promptBlocks: PromptBlock[];
  envReport: EnvironmentReport;
  lazyPromptBlocks: () => Promise<PromptBlock[]>;
  memoryStore: MemoryStore;
  moduleRegistry: ModuleRegistry;
  reasoningProbePromise: Promise<boolean>;
  reasoningStrategy: ReasoningStrategy;
  contextProbePromise: Promise<ContextProbeResult | null>;
  /** Живой реестр main-агента (клон на спавн; question/approve уже внутри). */
  toolRegistry: ToolRegistry;
  /** Живой менеджер main-агента (инстансы плагинов переиспользуются). */
  pluginManager: PluginManager;
  /** Хост черновиков capabilities (общий: черновики — проектные, не сессионные). */
  draftHost?: DraftHost;
  /** Живой менеджер сессий (forkPinned поверх общего стора). */
  sessionManager: SessionManager;
  skillsModule: { getSystemPromptBlock(): PromptBlock | null };
  indexerModule: { getSystemPromptBlock(): PromptBlock | null };
  /** Шаблон активных тегов (раннер берёт копию — enable_tools per-сессия). */
  activeToolTags: string[];
  /** Живой capabilities-пробник провайдера (та же ссылка, что у main). */
  capabilitiesProbeRef: { probe?: ModelCapabilities };
  /** Был ли включён --context-log (раннер пишет свой context.diff). */
  contextLogEnabled: boolean;
}

/**
 * Провайдер-срез env-отчёта под ФАКТИЧЕСКИЙ конфиг раннера. Раннер наследует
 * `envReport` bootstrap (провайдер на старте процесса), из-за чего
 * `session_start.environment` показывал чужой model/contextWindow после смены
 * провайдера/модели. Перезаписываем только provider-срез из живого конфига.
 */
function runnerEnvReport(base: EnvironmentReport, config: AppConfig): EnvironmentReport {
  if (!base.provider) return base;
  let baseUrl = base.provider.baseUrl;
  try {
    baseUrl = activeProviderEndpoint(config.provider).baseUrl || baseUrl;
  } catch {
    /* keep bootstrap baseUrl */
  }
  return {
    ...base,
    provider: {
      ...base.provider,
      model: config.model,
      baseUrl,
      contextWindow: config.contextWindow,
    },
  };
}

/**
 * Строит фабрику `(sessionId) => SessionRunner`. Спавн синхронный (только
 * файловые чтения слотов/истории), ленивый — по первому сообщению сессии.
 */
export function createSessionRunnerFactory(
  template: SessionRunnerTemplate,
): (sessionId: string) => SessionRunner {
  return (sessionId: string): SessionRunner => {
    const {
      config: bootConfig,
      configRef,
      logger,
      baseDir,
      configDir,
      promptBlocks,
      envReport,
      lazyPromptBlocks,
      memoryStore,
      moduleRegistry,
      reasoningProbePromise,
      reasoningStrategy,
      contextProbePromise,
      toolRegistry,
      pluginManager,
      draftHost,
      sessionManager,
      skillsModule,
      indexerModule,
      activeToolTags,
      capabilitiesProbeRef,
      contextLogEnabled,
    } = template;

    // Запиненный sibling поверх общего стора: пишет только свою сессию,
    // чужой activeId не трогает. Нет сессии — бросает (коллер уже вернул 404).
    const pinned = sessionManager.forkPinned(sessionId);

    // Живой конфиг — источник правды. Раннер, поднятый ПОСЛЕ смены модели/
    // провайдера, обязан собрать провайдера из него, а не из bootstrap-снимка
    // (`reconfigure` догоняет лишь уже закешированные раннеры): иначе новая
    // сессия/вкладка до первого reconfigure ходит старой моделью.
    const config = configRef.current ?? bootConfig;
    const { manager: providerManager, provider: llmProvider } = buildActiveProvider(
      config,
      logger,
      { getSessionId: () => pinned.getActiveMeta()?.id ?? sessionId },
    );

    // Свой Logger на раннер: посессионный `.log` и `sessionDir` (app.jsonl) —
    // иначе общий Logger перевешивался бы ходом соседней параллельной сессии.
    let runnerSessionDir: string | undefined;
    try {
      runnerSessionDir = sessionManager.getSessionDirectory(sessionId);
    } catch {
      runnerSessionDir = undefined;
    }
    const runnerLogger = logger.forSession(sessionId, runnerSessionDir);

    const contextManager = new ContextManager(
      config.contextWindow,
      config.contextBudget,
      new TokenCounter(config.model),
    );

    const runnerExec = new ExecutionModule(
      baseDir,
      config.stuckThreshold,
      config.errorWebSearch?.threshold ?? 5,
    );
    runnerExec.setAutoAdvance(config.execution?.autoAdvance ?? true);
    // Только слот своей сессии (без legacy-adopt — его сделал main на старте).
    runnerExec.switchSession(sessionId);
    const runnerDetector = new HallucinationDetector(baseDir, llmProvider, {
      judgeEnabled: config.hallucination?.judge?.enabled ?? false,
      sessionId,
    });
    runnerExec.setHallucinationDetector(runnerDetector);
    contextManager.setPlanSummaryProvider(() => runnerExec.getPlanSummary());

    // Реестр/плагины/исполнитель — свои (разделяются только stateless
    // определения тулов и ctx-чистые инстансы плагинов).
    const registry = buildRunnerRegistry(toolRegistry, runnerExec);
    const runnerPlugins = buildRunnerPlugins(pluginManager, runnerExec);
    // Тулы плагинов в клон реестра: `buildRunnerRegistry` копирует определения
    // на момент спавна, а плагин мог подгрузиться или быть выключен позже.
    runnerPlugins.attachToolRegistry(registry);
    const { toolCtx, runnerTags } = buildRunnerToolCtx({
      configRef,
      logger,
      baseDir,
      contextManager,
      sessionManager: pinned,
      sessionId,
      activeToolTags,
      capabilitiesProbeRef,
      draftHost,
    });
    const toolExecutor = buildRunnerExecutor(registry, toolCtx, runnerPlugins);
    toolCtx.llmProvider = llmProvider;
    toolCtx.toolExecutor = toolExecutor;

    // Сессионный модуль для dynamic-блоков — свой (id/имя в системном промпте).
    const runnerSessionModule = new SessionModule(pinned);
    const getDynamicPromptBlocks = buildRunnerDynamicBlocks({
      config,
      skillsModule,
      sessionModule: runnerSessionModule,
      indexerModule,
      registry,
      runnerTags,
      toolAllowlist: toolCtx.toolAllowlist,
      pluginManager: runnerPlugins,
    });

    const contextLogger = createRunnerContextLogger({
      enabled: contextLogEnabled,
      sessionManager: pinned,
      sessionId,
      config,
      logger: runnerLogger,
    });

    const agent = assembleRunnerAgent({
      config,
      configRef,
      llmProvider,
      providerManager,
      toolExecutor,
      runnerPlugins,
      contextManager,
      runnerDetector,
      logger: runnerLogger,
      baseDir,
      configDir,
      runnerTags,
      promptBlocks,
      envReport: runnerEnvReport(envReport, config),
      getDynamicPromptBlocks,
      lazyPromptBlocks,
      sessionManager: pinned,
      memoryStore,
      moduleRegistry,
      contextLogger,
      reasoningProbePromise,
      reasoningStrategy,
      runnerExec,
      toolCtx,
      contextProbePromise,
      registry,
    });
    seedRunnerHistory(agent, pinned, sessionId);

    return {
      sessionId,
      agent,
      contextManager,
      sessionManager: pinned,
      toolExecutor,
      toolCtx,
      execModule: runnerExec,
      pluginManager: runnerPlugins,
      registry,
      contextLogger,
      dispose: () => runnerPlugins.detachToolRegistry(registry),
    };
  };
}

/** Входы сборки агента раннера (тот же состав deps, что у main). */
interface AssembleRunnerAgentInput {
  config: AppConfig;
  configRef: { current: AppConfig };
  llmProvider: LLMProvider;
  providerManager: ProviderManager;
  toolExecutor: ToolExecutor;
  runnerPlugins: PluginManager;
  contextManager: ContextManager;
  runnerDetector: HallucinationDetector;
  logger: Logger;
  baseDir: string;
  configDir: string;
  runnerTags: string[];
  promptBlocks: PromptBlock[];
  envReport: EnvironmentReport;
  getDynamicPromptBlocks: () => PromptBlock[];
  lazyPromptBlocks: () => Promise<PromptBlock[]>;
  sessionManager: SessionManager;
  memoryStore: MemoryStore;
  moduleRegistry: ModuleRegistry;
  contextLogger: ContextLogger | undefined;
  reasoningProbePromise: Promise<boolean>;
  reasoningStrategy: ReasoningStrategy;
  runnerExec: ExecutionModule;
  toolCtx: ToolContext;
  contextProbePromise: Promise<ContextProbeResult | null>;
  registry: ToolRegistry;
}

/**
 * Собирает агента раннера тем же составом deps, что main (порядок 1:1
 * с agent-phase): late-проба контекста + set_thinking в СВОЙ реестр.
 */
function assembleRunnerAgent(input: AssembleRunnerAgentInput): Agent {
  const {
    config,
    configRef,
    llmProvider,
    providerManager,
    toolExecutor,
    runnerPlugins,
    contextManager,
    runnerDetector,
    logger,
    baseDir,
    configDir,
    runnerTags,
    promptBlocks,
    envReport,
    getDynamicPromptBlocks,
    lazyPromptBlocks,
    sessionManager,
    memoryStore,
    moduleRegistry,
    contextLogger,
    reasoningProbePromise,
    reasoningStrategy,
    runnerExec,
    toolCtx,
    contextProbePromise,
    registry,
  } = input;
  const agentDeps: AgentDeps = {
    config,
    configRef,
    llmProvider,
    getProviderName: () => providerManager.activeName,
    toolExecutor,
    pluginManager: runnerPlugins,
    contextManager,
    hallucinationDetector: runnerDetector,
    logger,
    baseDir,
    configDir,
    toolTags: runnerTags,
    promptBlocks: [...promptBlocks],
    envReport,
    getDynamicPromptBlocks,
    finalAudit: () => runnerExec.runFinalAudit(),
    lazyPromptBlocks,
    sessionManager,
    memoryStore,
    moduleRegistry,
    exitOnComplete: false,
    contextLogger,
    reasoningProbe: () => reasoningProbePromise,
    reasoningStrategy,
    planSummary: () => runnerExec.getPlanSummary(),
    toolCtx,
  };
  const agent = new Agent(agentDeps);

  // Поздний резолв пробы (зеркало agent-phase): окно могло попасть в конфиг
  // после сборки провайдера. No-op, если значение то же или ход уже был.
  // При применении правим env-снимок раннера (session_start без до-пробного окна).
  void contextProbePromise
    .then(async (probe) => {
      if (!probe) return;
      const applied = await applyProbedContext(
        agent,
        config,
        probe,
        logger as SilentLogger,
        // Пин на сессию раннера: мета этой сессии должна получить реальное
        // окно, иначе сайдбар/`session show` показывают стартовое значение.
        sessionManager,
      );
      if (applied && envReport.provider) {
        envReport.provider.contextWindow = config.contextWindow;
        envReport.provider.model = config.model;
      }
    })
    .catch(() => {});

  // Тул set_thinking — на reasoningState СВОЕГО агента (main-версия из клона
  // выкинута выше; дубли в одном реестре запрещены).
  if (config.reasoning) {
    const setThinkingTool = createSetThinkingTool(
      agent.reasoningState,
      config.reasoning,
      () => agent.currentIteration,
    );
    registry.register(setThinkingTool, "core");
  }
  return agent;
}

/**
 * Подхват истории существующей сессии (зеркало REPL /resume): новый раннер
 * старой сессии стартует не с пустого контекста, а с её истории из стора.
 */
function seedRunnerHistory(
  agent: Agent,
  sessionManager: SessionManager,
  sessionId: string,
): void {
  try {
    const history = sessionManager.getHistory(sessionId);
    if (history.length > 0) agent.setContext(history);
  } catch {
    // fail-open: история не поднялась — ход начнётся с пустого контекста
  }
}

/** Входы создания context.diff раннера. */
interface RunnerContextLogInput {
  enabled: boolean;
  sessionManager: SessionManager;
  sessionId: string;
  config: AppConfig;
  logger: Logger;
}

/** Git-style лог контекста раннера (opt-in, рядом с файлами его сессии). */
function createRunnerContextLogger(input: RunnerContextLogInput): ContextLogger | undefined {
  if (!input.enabled) return undefined;
  try {
    return new ContextLogger({
      path: join(input.sessionManager.getSessionDirectory(input.sessionId), "context.diff"),
      sessionId: input.sessionId,
      model: input.config.model,
      contextWindow: input.config.contextWindow,
      redact: input.config.contextLog?.redact !== false,
    });
  } catch (err) {
    input.logger.warn(
      `context-log init failed for ${input.sessionId}: ${String((err as Error)?.message ?? err)}`,
    );
    return undefined;
  }
}
