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
import type { ContextManager } from "../../modules/context/manager";
import type { SessionManager } from "../../modules/session/index";
import type { ToolContext } from "../../tools/types";
import type { PromptBlock } from "../types";
import type { ContextProbeResult } from "../../llm/model-loader";
import type { MemoryStore } from "../../modules/memory/store";
import type { ModuleRegistry } from "../../modules/registry";
import type { ToolRegistry } from "../../tools/index";
import type { ExecutionModule } from "../../modules/execution/module";
import type { HallucinationDetector } from "../../modules/hallucination/detector";
import type { ContextLogger } from "../agent/context-log";
import type { EnvironmentReport } from "../environment";
import { applyProbedContext } from "./provider-phase";
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
    exitOnComplete,
    contextLogger,
    reasoningProbePromise,
    reasoningStrategy,
    execModule,
    toolCtx,
    contextProbePromise,
  } = input;

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
    exitOnComplete,
    contextLogger,
    reasoningProbe: () => reasoningProbePromise,
    reasoningStrategy,
    planSummary: () => execModule.getPlanSummary(),
    toolCtx,
  };

  const agent = new Agent(agentDeps);

  // Поздний резолв пробы: окно могло попасть в `config` после сборки
  // ContextManager/провайдера — один reconfigure, чтобы бюджеты и провайдер
  // его реально использовали. No-op, если проба села рано (то же значение)
  // или ход уже был.
  void contextProbePromise
    .then((probe) => {
      if (!probe) return;
      return applyProbedContext(agent, config, probe, logger as SilentLogger);
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
    toolRegistry.register(setThinkingTool);
  }

  return agent;
}
