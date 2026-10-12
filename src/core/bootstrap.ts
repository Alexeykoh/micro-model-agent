/** Bootstrap агента: конфиг, провайдер, тулы, модули, Agent (тонкий оркестратор фаз). */
import type { Logger } from "../logger/app-logger";
import type { ExecutionModule } from "../modules/execution/module";
import type { SessionManager } from "../modules/session/index";
import type { SkillsModule } from "../modules/skills/index";
import type { PluginManager } from "../modules/plugins/manager";
import type { IndexerModule } from "../modules/indexer/index";
import type { MemoryStore } from "../modules/memory/store";
import type { Agent } from "./agent";
import type { ToolContext } from "../tools/types";
import type { ToolRegistry } from "../tools/index";
import type { ContextProbeResult } from "../llm/model-loader";
import { initConfigPhase } from "./bootstrap/config-phase";
import { setupProviderPhase } from "./bootstrap/provider-phase";
import { setupWorkspacePhase } from "./bootstrap/workspace-phase";
import { setupSessionPhase } from "./bootstrap/session-phase";
import { setupModulesPhase } from "./bootstrap/modules-phase";
import { assembleAgent } from "./bootstrap/agent-phase";
import {
  createSessionRunnerFactory,
  type SessionRunner,
} from "./bootstrap/session-runner";
import { t } from "../i18n/index";

// Публичные экспорты 1:1 (сигнатуры и поведение не меняются) — потребители
// (cli/main, web-command, тесты) продолжают импортить из "../core/bootstrap".
export { applyReasoningCliOverride } from "./bootstrap/config-phase";
export { applyProbedContext } from "./bootstrap/provider-phase";
export { resolveBaseDir } from "./bootstrap/workspace-phase";
export { agentsMdPaths, setOneShotMode } from "./bootstrap/state";
export { buildSystemInfo } from "./system-prompt";

/** Итог bootstrap: агент, конфиг, логгеры, модули, пробы. */
export interface BootstrapResult {
  agent: Agent;
  config: import("../config/types").AppConfig;
  logger: Logger;
  sessionManager: SessionManager;
  skillsModule: SkillsModule;
  pluginManager: PluginManager;
  /** Хост черновиков capabilities (черновик — проектный, не сессионный). */
  draftHost: import("../modules/plugins/drafts").DraftHost;
  /** Владелец состояния плана — UI (REPL) читают активный план отсюда, а не перечитывают .mma/plans/active.json. */
  execModule: ExecutionModule;
  /** Общий ToolContext; `sessionId`/`sessionContext` — живые геттеры поверх
   *  менеджера сессий, смена сессии отражается всегда. */
  toolCtx: ToolContext;
  /** Живой реестр тулов. Веб-режим дорегистрирует интерактивные тулы
   *  (question/approve) после bootstrap, не трогая терминал. */
  toolRegistry: ToolRegistry;
  configDir: string;
  baseDir: string;
  noAgentsMd: boolean;
  envReport: import("./environment").EnvironmentReport;
  /** true при легаси config.json (доменных файлов нет). */
  legacyDetected: boolean;
  /** Фоновая проба длины контекста, с которой модель РЕАЛЬНО загружена
   *  (LM Studio native API). Null, если неприменимо. */
  contextProbe: Promise<ContextProbeResult | null>;
  /** Общий глобальный стор памяти — один инстанс у модуля памяти и цикла,
   *  поэтому UI (`mma web` `/memory`) читают/пишут живые данные. */
  memoryStore: MemoryStore;
  /** Индексатор карты проекта — веб-режим показывает статистику в панели окружения. */
  indexerModule: IndexerModule;
  /** Модуль LSP — веб-режим показывает диагностику во вкладке LSP. */
  lspModule?: import("../modules/lsp/module").LspModule;
  /** Владелец жизненного цикла модулей (`setup`/`dispose`, INV-5/7/8). */
  moduleHost: import("./module-host").ModuleHost;
  /**
   * Фабрика per-session раннеров для настоящего параллелизма (`mma web`):
   * `(sessionId) => SessionRunner` (свой агент/контекст/трекер поверх общего
   * стора и провайдера). Отсутствует только в тестах, собирающих результат
   * вручную, — веб без неё работает в legacy single-flight режиме.
   */
  spawnSessionRunner?: (sessionId: string) => SessionRunner;
}

/**
 * Собирает всё для работы агента: конфиг, окружение, провайдер, пробы,
 * тулы, модули, Agent. Тяжёлые старты (health-check, пробы) — фоном.
 * Тонкий оркестратор: каждая фаза — в `src/core/bootstrap/*.ts`.
 * @param configDir каталог конфига; @param projectDir workspace;
 * @param noAgentsMd пропустить AGENTS.md; @param exitOnComplete стоп на первом ответе;
 * @param reasoningLevel CLI-override reasoning; @param contextLog git-лог контекста.
 * @returns агент и окружение.
 */
export async function bootstrap(
  configDir?: string,
  projectDir?: string,
  noAgentsMd?: boolean,
  exitOnComplete?: boolean,
  reasoningLevel?: string,
  contextLog?: boolean,
): Promise<BootstrapResult> {
  // Фаза 1: пути, конфиг, локаль, логгер.
  const { dir, config, legacyDetected, logger } = await initConfigPhase(
    configDir,
    projectDir,
    reasoningLevel,
  );

  // Фаза 2: провайдер, автозагрузка модели, фоновые пробы, профиль.
  const provider = await setupProviderPhase(config, logger, dir);

  // Фаза 3: workspace, окружение, индекс, скиллы, реестр тулов, system-блок.
  const workspace = await setupWorkspacePhase(config, logger, dir, projectDir, provider.profile);

  // Фаза 4: сессии, context-лог, менеджер контекста, живой toolCtx.
  const session = await setupSessionPhase({
    config,
    logger,
    dir,
    baseDir: workspace.baseDir,
    exitOnComplete,
    contextLogFlag: contextLog,
    contextProbePromise: provider.contextProbePromise,
    capabilitiesRef: provider.capabilitiesRef,
    llmProvider: provider.llmProvider,
    bindSessionManager: provider.bindSessionManager,
    toolRegistry: workspace.toolRegistry,
    pluginManager: workspace.pluginManager,
    draftHost: workspace.draftHost,
  });

  // Фаза 5: модули, плагины, промпт-блоки, dry-run переполнения.
  const modules = await setupModulesPhase({
    config,
    logger,
    dir,
    baseDir: workspace.baseDir,
    noAgentsMd,
    exitOnComplete,
    toolRegistry: workspace.toolRegistry,
    pluginManager: workspace.pluginManager,
    skillsModule: workspace.skillsModule,
    indexerModule: workspace.indexerModule,
    sessionManager: session.sessionManager,
    contextManager: session.contextManager,
    toolCtx: session.toolCtx,
    activeToolTags: session.activeToolTags,
    hallucinationDetector: session.hallucinationDetector,
    systemInfoPrompt: workspace.systemInfoPrompt,
  });

  // Черновики capabilities: грузим только одобренные проектом. Именно здесь,
  // а не в фазе workspace, — менеджер уже знает про плагины, а `toolRegistry`
  // уже подписан на вклад тулов, так что capability сразу попадёт в набор.
  const draftReport = workspace.draftHost.loadApproved();
  if (draftReport && draftReport.loaded > 0) {
    logger.warn(
      t("plugin.drafts_loaded", { loaded: String(draftReport.loaded), failed: String(draftReport.failed) }),
    );
  }

  // Фаза 6: AgentDeps, late-apply пробы, set_thinking.
  const agent = await assembleAgent(
    {
      config,
      configRef: session.configRef,
      llmProvider: provider.llmProvider,
      providerManager: provider.providerManager,
      toolExecutor: session.toolExecutor,
      pluginManager: workspace.pluginManager,
      contextManager: session.contextManager,
      hallucinationDetector: session.hallucinationDetector,
      logger,
      baseDir: workspace.baseDir,
      configDir: dir,
      activeToolTags: session.activeToolTags,
      promptBlocks: modules.promptBlocks,
      envReport: workspace.envReport,
      getDynamicPromptBlocks: modules.getDynamicPromptBlocks,
      lazyPromptBlocks: modules.lazyPromptBlocks,
      sessionManager: session.sessionManager,
      memoryStore: modules.memoryStore,
      moduleRegistry: modules.moduleRegistry,
      moduleHost: modules.moduleHost,
      exitOnComplete,
      contextLogger: session.contextLogger,
      reasoningProbePromise: provider.reasoningProbePromise,
      reasoningStrategy: provider.reasoningStrategy,
      execModule: modules.execModule,
      toolCtx: session.toolCtx,
      contextProbePromise: provider.contextProbePromise,
    },
    workspace.toolRegistry,
  );

  return {
    agent,
    config,
    logger,
    sessionManager: session.sessionManager,
    skillsModule: workspace.skillsModule,
    pluginManager: workspace.pluginManager,
    execModule: modules.execModule,
    toolCtx: session.toolCtx,
    toolRegistry: workspace.toolRegistry,
    configDir: dir,
    baseDir: workspace.baseDir,
    noAgentsMd: noAgentsMd === true,
    envReport: workspace.envReport,
    legacyDetected,
    contextProbe: provider.contextProbePromise,
    memoryStore: modules.memoryStore,
    indexerModule: workspace.indexerModule,
    lspModule: modules.lspModule,
    /** Владелец жизненного цикла модулей: `dispose()` на завершении процесса. */
    moduleHost: modules.moduleHost,
    /** Хост черновиков capabilities (`mma plugins drafts`, тул `define_capability`). */
    draftHost: workspace.draftHost,
    spawnSessionRunner: createSessionRunnerFactory({
      config,
      configRef: session.configRef,
      logger,
      baseDir: workspace.baseDir,
      configDir: dir,
      promptBlocks: modules.promptBlocks,
      envReport: workspace.envReport,
      lazyPromptBlocks: modules.lazyPromptBlocks,
      memoryStore: modules.memoryStore,
      moduleRegistry: modules.moduleRegistry,
      reasoningProbePromise: provider.reasoningProbePromise,
      reasoningStrategy: provider.reasoningStrategy,
      contextProbePromise: provider.contextProbePromise,
      toolRegistry: workspace.toolRegistry,
      pluginManager: workspace.pluginManager,
      draftHost: workspace.draftHost,
      sessionManager: session.sessionManager,
      skillsModule: workspace.skillsModule,
      indexerModule: workspace.indexerModule,
      activeToolTags: session.activeToolTags,
      capabilitiesProbeRef: provider.capabilitiesRef,
      contextLogEnabled: session.contextLogger !== undefined,
    }),
  };
}
