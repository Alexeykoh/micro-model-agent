/**
 * Фаза 5 bootstrap: модули, плагины, промпт-блоки.
 *
 * Порядок 1:1 с исходником: ExecutionModule (+ restorePlan, детектор) →
 * SessionModule → IndexerModule в реестр → MCP (init с таймаутом 10s) →
 * Memory → Browser (опционально) → LSP → фоновый стартовый health-check →
 * сбор tool definitions модулей → builtin-плагины в менеджер → внешние
 * плагины (global + project) → onCompact/setPlanSummaryProvider → AGENTS.md
 * блоки + статичные промпт-блоки → стартовый dry-run переполнения (варнинг).
 */
import { join } from "path";
import { ModuleRegistry } from "../../modules/registry";
import { PluginLoader } from "../../modules/plugins/loader";
import { plugin as angular11Plugin } from "../../modules/plugins/builtin/angular11";
import { plugin as lintOnWritePlugin } from "../../modules/plugins/builtin/lint-on-write";
import { plugin as notifyPlugin } from "../../modules/plugins/builtin/notify";
import { ExecutionModule } from "../../modules/execution/module";
import { SessionModule } from "../../modules/session/index";
import { BrowserModule } from "../../modules/browser/index";
import { LspModule, FileOnlyLogger, DEFAULT_LSP_CONFIG } from "../../modules/lsp/index";
import { runStartupHealthCheck } from "../../modules/lsp/startup-check";
import { MCPModule } from "../../modules/mcp/index";
import { mcpModuleDef } from "../../modules/mcp/lifecycle";
import { lspModuleDef } from "../../modules/lsp/lifecycle";
import { browserModuleDef } from "../../modules/browser/lifecycle";
import { executionModuleDef } from "../../modules/execution/lifecycle";
import { sessionModuleDef } from "../../modules/session/lifecycle";
import { indexerModuleDef } from "../../modules/indexer/lifecycle";
import { memoryModuleDef } from "../../modules/memory/lifecycle";
import { skillsModuleDef } from "../../modules/skills/lifecycle";
import { documentsModuleDef } from "../../modules/documents";
import { MemoryModule } from "../../modules/memory/module";
import { MemoryStore } from "../../modules/memory/store";
import { setMemoryEncryptor } from "../../modules/memory/at-rest"; import { SessionFileEncryptor } from "../../modules/security/session-encryption";
import type { PromptBlock } from "../types";
import { readMmaVersion } from "../version";
import { isOneShotMode, registerBuiltinPlugin } from "./state";
import { ModuleHost, registerOwnedTools } from "../module-host";
import { restoreStartupPlanFrom } from "./startup-plan";
import { defaultOutputBus } from "../../output";
import { globalPluginsDir as resolveGlobalPluginsDir, projectMmaDir } from "../../config/paths";
import type { ModulesPhaseInput, ModulesPhase } from "./state";
import {
  buildStaticPromptBlocks,
  collectDynamicPromptBlocks,
  dryRunStartupOverflow,
  makeLazyPromptBlocks,
} from "./modules-prompt";

/**
 * Регистрирует модули, грузит плагины и собирает промпт-блоки.
 * Тонкий оркестратор: вся пошаговая логика — в приватных хелперах ниже,
 * порядок сайд-эффектов 1:1 с исходной монолитной версией.
 * @param input связный вход фазы (см. ModulesPhaseInput в state.ts).
 * @returns реестр модулей, exec-модуль и блоки системного промпта.
 */
export async function setupModulesPhase(input: ModulesPhaseInput): Promise<ModulesPhase> {
  const moduleRegistry = new ModuleRegistry();
  // Единый владелец жизненного цикла модулей (INV-2/5/7/8): `setup()` — до сбора
  // тулов/блоков, `dispose()` — на завершении процесса (см. `BootstrapResult`).
  const moduleHost = new ModuleHost(input.config, input.logger, defaultOutputBus);

  const core = await registerCoreModules(input, moduleRegistry);
  const languages = startLanguageModules(input, moduleRegistry);
  const startupCheckPromise = languages.startupCheck;
  // Единый хост жизненного цикла и сбора тулов (INV-2/5/7/8); порядок — как в ModuleRegistry.
  moduleHost.register(executionModuleDef(core.execModule));
  moduleHost.register(sessionModuleDef(core.sessionModule));
  moduleHost.register(indexerModuleDef(input.indexerModule));
  moduleHost.register(mcpModuleDef(core.mcpModule));
  moduleHost.register(memoryModuleDef(core.memoryModule));
  if (languages.browserModule) moduleHost.register(browserModuleDef(languages.browserModule));
  moduleHost.register(lspModuleDef(languages.lspModule));
  moduleHost.register(skillsModuleDef(input.skillsModule));
  moduleHost.register(documentsModuleDef());
  await moduleHost.setup();
  registerModuleToolsAndPlugins(input, moduleHost);

  const promptBlocks = buildStaticPromptBlocks(input, moduleHost, core.execModule);
  dryRunStartupOverflow(input, promptBlocks);

  // План-блок удалён: мутирует каждую итерацию (статусы шагов), инвалидируя
  // локальный KV-кеш. Статус плана теперь инжектится в <system-summary>
  // после каждого пакета тулов.
  const getDynamicPromptBlocks = (): PromptBlock[] =>
    collectDynamicPromptBlocks(input, core.sessionModule);
  const lazyPromptBlocks = makeLazyPromptBlocks(startupCheckPromise);

  return {
    moduleRegistry,
    moduleHost,
    execModule: core.execModule,
    sessionModule: core.sessionModule,
    mcpModule: core.mcpModule,
    memoryStore: core.memoryStore,
    lspModule: languages.lspModule,
    promptBlocks,
    lazyPromptBlocks,
    getDynamicPromptBlocks,
  };
}

/** Ядро реестра: exec/сессия/индекс/MCP/память. */
interface CoreModules {
  execModule: ExecutionModule;
  sessionModule: SessionModule;
  mcpModule: MCPModule;
  memoryModule: MemoryModule;
  memoryStore: MemoryStore;
}

/** Exec + Session + Indexer + MCP (init с таймаутом) + Memory. */
async function registerCoreModules(
  input: ModulesPhaseInput,
  moduleRegistry: ModuleRegistry,
): Promise<CoreModules> {
  const { config, dir, baseDir, hallucinationDetector } = input;
  const execModule = new ExecutionModule(
    baseDir,
    config.stuckThreshold,
    config.errorWebSearch?.threshold ?? 5,
    undefined,
    undefined,
    config.security?.paths,
  );
  execModule.setAutoAdvance(config.execution?.autoAdvance ?? true);
  // План следует за сессией: стартовая грузит СВОЙ слот, не чужой active.json.
  restoreStartupPlanFrom(execModule, input.sessionManager);
  moduleRegistry.register(execModule);
  execModule.setHallucinationDetector(hallucinationDetector);
  const sessionModule = new SessionModule(input.sessionManager);
  moduleRegistry.register(sessionModule);

  moduleRegistry.register(input.indexerModule);

  const mcpModule = new MCPModule(config);
  // Жизненный цикл MCP — в общем ModuleHost (INV-2/5/8): `initialize()` и таймаут
  // объявляет контракт (`mcpModuleDef`), а не bootstrap. MCP остаётся в
  // ModuleRegistry для сбора тулов/плагинов (единый путь сбора — шаг W1.3+).
  moduleRegistry.register(mcpModule);

  // Общий глобальный стор памяти — один инстанс у модуля памяти и цикла,
  // поэтому UI (`mma web` `/memory`) читают/пишут живые данные.
  const memoryStore = new MemoryStore(join(dir, "memory"), config.memory?.validator); setMemoryEncryptor(new SessionFileEncryptor(config.security?.sessionEncryption));
  const memoryModule = new MemoryModule(memoryStore);
  moduleRegistry.register(memoryModule);

  return { execModule, sessionModule, mcpModule, memoryModule, memoryStore };
}

/**
 * Языковые модули: Browser (опционально) + LSP + фоновый стартовый health-check.
 * @returns LSP-модуль (для web-вкладки) и промис стартовой проверки (без await —
 * резолвится к первому вводу).
 */
function startLanguageModules(
  input: ModulesPhaseInput,
  moduleRegistry: ModuleRegistry,
): {
  lspModule: LspModule;
  startupCheck: Promise<PromptBlock | null>;
  browserModule?: BrowserModule;
} {
  const { config, logger, baseDir, exitOnComplete } = input;

  let browserModule: BrowserModule | undefined;
  if (config.browser.enabled) {
    browserModule = new BrowserModule();
    moduleRegistry.register(browserModule);
  }

  const lspLogger = new FileOnlyLogger(logger);
  const lspModule = new LspModule(config.lsp, undefined, lspLogger, baseDir);
  moduleRegistry.register(lspModule);

  // LSP как внешний источник определений для `project_map symbol`: включается
  // только когда индекс не нашёл совпадений (спавн сервера не на каждый запрос).
  input.indexerModule.setSymbolProvider((query, language) =>
    lspModule.workspaceSymbol(query, baseDir, language),
  );

  // Прогрев LSP в фоне: вкладку LSP и первый файл открывают до первого хода,
  // иначе каждый старт платит холодный сервер. One-shot и тесты — без прогрева.
  const interactive = !isOneShotMode() && !exitOnComplete && process.env.NODE_ENV !== "test";
  if (interactive) lspModule.warmProject();

  // Стартовый health-check: baseline ошибок проекта до работы. Старт фоном (без
  // await), чтобы баннер REPL не ждал `npx tsc`; Agent дожидается через
  // `lazyPromptBlocks` перед первым LLM-вызовом.
  const startupCheck = interactive
    ? runStartupHealthCheck(config.lsp ?? DEFAULT_LSP_CONFIG, baseDir, { logger: lspLogger })
    : Promise.resolve(null);
  return { lspModule, startupCheck, browserModule };
}

/** Тулы модулей в реестр + builtin/external плагины в менеджер. */
function registerModuleToolsAndPlugins(input: ModulesPhaseInput, moduleHost: ModuleHost): void {
  const { logger, baseDir, toolRegistry, pluginManager } = input;

  // Единый источник определений тулов — хост (INV-2): владельца проставляет
  // `collectTools` из имени модуля, запись — через `registerOwnedTools`.
  const moduleTools = moduleHost.collectTools();
  registerOwnedTools(
    toolRegistry,
    moduleTools.map((tool) => ({ tool, owner: tool.owner })),
  );

  // Хуки модулей — тоже из хоста (INV-2/INV-16): один путь сбора, порядок =
  // порядок инициализации модулей. Плагин памяти в хук не объявлен намеренно
  // (её `onBuildPrompt` задвоил бы промпт-блок памяти).
  for (const plugin of moduleHost.collectHooks()) {
    registerBuiltinPlugin(pluginManager, plugin);
  }

  for (const builtin of [angular11Plugin, lintOnWritePlugin, notifyPlugin])
    pluginManager.register(builtin);

  const pluginLoader = new PluginLoader();
  const globalPluginsDir = resolveGlobalPluginsDir();
  const projectPluginsDir = join(projectMmaDir(baseDir), "plugins");
  const mmaVersion = readMmaVersion();
  // Каталоги нужны менеджеру для `reload()`: CLI, REPL и веб перезагружают
  // одни и те же каталоги и не должны знать про пути сами.
  pluginManager.setSourceDirs({ globalPluginsDir, projectPluginsDir }, mmaVersion);
  pluginLoader.loadFromDir(globalPluginsDir, pluginManager, logger, {
    source: "global",
    mmaVersion,
  });
  pluginLoader.loadFromDir(projectPluginsDir, pluginManager, logger, {
    source: "project",
    mmaVersion,
  });

  // Вклад плагинов в тулы: после регистрации всех (в т.ч. внешних), иначе
  // раннеры и перезагрузка смотрели бы на устаревший набор.
  pluginManager.attachToolRegistry(toolRegistry);
}
