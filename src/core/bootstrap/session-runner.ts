/**
 * Фабрика per-session раннеров для настоящего параллелизма (`mma web`).
 *
 * Один `Agent` — не reentrant (abort/shutdown/итерации/контекст — поля
 * инстанса), а ContextManager/SessionManager/ExecutionModule держат одну
 * активную сессию на процесс. Поэтому каждая одновременно бегущая сессия
 * получает СВОЙ раннер: агент + контекст + запиненный менеджер сессий +
 * трекер плана + исполнитель тулов. Разделяются только stateless/длинноживущее:
 * конфиг, провайдер, реестр-шаблон, инстансы плагинов, память, индекс.
 * Прецедент — тул `subagent` (свой ContextManager/PluginManager/
 * HallucinationDetector поверх shared executor/provider).
 */
import { Agent } from "../agent";
import { moduleOf } from "../../output";
import type { ContextManager } from "../../core/context/manager";
import { createContextManager } from "./context-factory";
import type { SessionManager } from "../../modules/session/index";
import { admissionDiagnosticSink } from "./tool-context";
import { SessionModule } from "../../modules/session/module";
import { ExecutionModule } from "../../modules/execution/module";
import { HallucinationDetector } from "../../core/hallucination/detector";
import type { ToolExecutor } from "../../tools/executor";
import type { ToolRegistry } from "../../tools/registry";
import type { PluginManager } from "../../modules/plugins/manager";
import type { ToolContext } from "../../tools/types";
import { ContextLogger } from "../agent/context-log";
import { buildActiveProvider } from "../../modules/providers/factory";
import {
  buildRunnerDynamicBlocks,
  buildRunnerExecutor,
  buildRunnerPlugins,
  buildRunnerRegistry,
  buildRunnerToolCtx,
} from "./session-runner-scope";
import {
  assembleRunnerAgent,
  createRunnerContextLogger,
  runnerEnvReport,
  seedRunnerHistory,
  type SessionRunnerTemplate,
} from "./session-runner-wiring";

export type { SessionRunnerTemplate };

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

    // Живой конфиг — источник правды. Раннер после смены модели/провайдера
    // обязан собрать провайдера из него, а не из bootstrap-снимка.
    const config = configRef.current ?? bootConfig;
    const { manager: providerManager, provider: llmProvider } = buildActiveProvider(
      config,
      logger,
      {
        getSessionId: () => pinned.getActiveMeta()?.id ?? sessionId,
        onDiagnostic: admissionDiagnosticSink(pinned),
      },
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

    // INV-15: `context_degraded` — в свою сессию раннера (запиненный sibling).
    const contextManager = createContextManager(config, baseDir, pinned);

    const runnerExec = new ExecutionModule(
      baseDir,
      config.stuckThreshold,
      config.errorWebSearch?.threshold ?? 5,
      undefined,
      undefined,
      config.security?.paths,
      runnerLogger.child?.("execution") ?? runnerLogger,
    );
    runnerExec.setAutoAdvance(config.execution?.autoAdvance ?? true);
    // Только слот своей сессии (без legacy-adopt — его сделал main на старте).
    runnerExec.switchSession(sessionId);
    const runnerDetector = new HallucinationDetector(baseDir, llmProvider, {
      judgeEnabled: config.hallucination?.judge?.enabled ?? false,
      sessionId,
      // INV-15: судья деградировала в `pass` — различать от «противоречий нет».
      onDiagnostic: admissionDiagnosticSink(pinned),
    });
    runnerExec.setHallucinationDetector(runnerDetector);
    // INV-15: fail-open верификатора раннера пишет `verify_error` в его сессию.
    runnerExec.setDiagnosticSink((event, diag) => {
      pinned.appendLog({
        ts: new Date().toISOString(),
        type: event,
        content: diag.cause ?? diag.operation,
        source: diag.source,
        module: moduleOf(diag.source),
        operation: diag.operation,
        errorKind: diag.kind,
        cause: diag.cause,
        recoverable: diag.recoverable,
      });
    });
    contextManager.setPlanSummaryProvider(() => runnerExec.getPlanSummary());

    // Реестр/плагины/исполнитель — свои (разделяются только stateless
    // определения тулов и ctx-чистые инстансы плагинов).
    const registry = buildRunnerRegistry(toolRegistry, runnerExec);
    const runnerPlugins = buildRunnerPlugins(
      pluginManager,
      runnerExec,
      logger.child?.("plugins") ?? logger,
    );
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
    const toolExecutor = buildRunnerExecutor(registry, toolCtx, runnerPlugins, pinned);
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
