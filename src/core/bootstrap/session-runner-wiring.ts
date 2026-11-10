/**
 * Шаги wiring раннера сессии: env-срез, сборка Agent-deps, подхват истории
 * и context.diff.
 *
 * Вынесено из `session-runner.ts` (правило #1: ≤300 строк/файл). Здесь —
 * вспомогательные шаги, а контракты и фабрика раннера остаются в
 * `session-runner.ts`.
 */
import { join } from "path";
import { Agent } from "../agent";
import type { AgentDeps } from "../agent";
import type { AppConfig, ReasoningStrategy } from "../../config/types";
import type { ProviderProbesBox } from "../agent/deps";
import type { Logger } from "../../logger/app-logger";
import type { LLMProvider } from "../../llm/provider";
import type { ProviderManager } from "../../modules/providers/manager";
import type { ContextManager } from "../../core/context/manager";
import type { SessionManager } from "../../modules/session/index";
import { admissionDiagnosticSink } from "./tool-context";
import { ExecutionModule } from "../../modules/execution/module";
import { HallucinationDetector } from "../../core/hallucination/detector";
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
import { activeProviderEndpoint } from "../../modules/providers/manager";
import { applyProbedContext } from "./provider-phase";
import type { SilentLogger } from "./state";
import { registerOwnedTools } from "../module-host";

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
  /** Живой бокс проб провайдера (та же ссылка, что у main): capabilities +
   *  reasoning-проба — после свитча читается актуальное, а не снимок. */
  capabilitiesProbeRef: ProviderProbesBox;
  /** Был ли включён --context-log (раннер пишет свой context.diff). */
  contextLogEnabled: boolean;
}

/**
 * Провайдер-срез env-отчёта под ФАКТИЧЕСКИЙ конфиг раннера. Раннер наследует
 * `envReport` bootstrap (провайдер на старте процесса), из-за чего
 * `session_start.environment` показывал чужой model/contextWindow после смены
 * провайдера/модели. Перезаписываем только provider-срез из живого конфига.
 */
export function runnerEnvReport(base: EnvironmentReport, config: AppConfig): EnvironmentReport {
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
  reasoningStrategy: ReasoningStrategy;
  runnerExec: ExecutionModule;
  toolCtx: ToolContext;
  contextProbePromise: Promise<ContextProbeResult | null>;
  registry: ToolRegistry;
  capabilitiesProbeRef: ProviderProbesBox;
}

/**
 * Собирает агента раннера тем же составом deps, что main (порядок 1:1
 * с agent-phase): late-проба контекста + set_thinking в СВОЙ реестр.
 */
export function assembleRunnerAgent(input: AssembleRunnerAgentInput): Agent {
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
    reasoningStrategy,
    runnerExec,
    toolCtx,
    contextProbePromise,
    registry,
    capabilitiesProbeRef,
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
    // Живая reasoning-проба из ОБЩЕГО бокса (INV-R2): после свитча провайдера
    // новый раннер читает актуальный вердикт, а не снимок bootstrap.
    reasoningProbe: () => capabilitiesProbeRef.reasoningProbe?.() ?? Promise.resolve(false),
    reasoningStrategy,
    capabilitiesProbeRef,
    planSummary: () => runnerExec.getPlanSummary(),
    planPendingSteps: () => runnerExec.getPlanPendingSteps(),
    toolCtx,
    onDiagnostic: admissionDiagnosticSink(sessionManager),
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
    registerOwnedTools(registry, [{ tool: setThinkingTool, owner: "core" }]);
  }
  return agent;
}

/**
 * Подхват истории существующей сессии (зеркало REPL /resume): новый раннер
 * старой сессии стартует не с пустого контекста, а с её истории из стора.
 */
export function seedRunnerHistory(
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
export function createRunnerContextLogger(
  input: RunnerContextLogInput,
): ContextLogger | undefined {
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
