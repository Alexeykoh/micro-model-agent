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
import { buildHiddenToolsBlock } from "../../tools/hidden-tools-block";
import { ModuleRegistry } from "../../modules/registry";
import { PluginLoader } from "../../modules/plugins/loader";
import { plugin as lintOnWritePlugin } from "../../modules/plugins/builtin/lint-on-write";
import { plugin as notifyPlugin } from "../../modules/plugins/builtin/notify";
import { ExecutionModule } from "../../modules/execution/module";
import { SessionModule } from "../../modules/session/index";
import { BrowserModule } from "../../modules/browser/index";
import { LspModule, FileOnlyLogger, DEFAULT_LSP_CONFIG } from "../../modules/lsp/index";
import { runStartupHealthCheck } from "../../modules/lsp/startup-check";
import { MCPModule } from "../../modules/mcp/index";
import { MemoryModule } from "../../modules/memory/module";
import { MemoryStore } from "../../modules/memory/store";
import { t } from "../../i18n/index";
import { estimateTokens } from "../../llm/token-counter";
import type { PromptBlock } from "../types";
import { readMmaVersion } from "../version";
import { dryRunOverflow, overflowHint } from "../prompt-overflow";
import { isOneShotMode, loadAgentsMdBlocks, registerBuiltinPlugin, withTimeout } from "./state";
import { globalPluginsDir as resolveGlobalPluginsDir, projectMmaDir } from "../../config/paths";
import type { ModulesPhaseInput, ModulesPhase } from "./state";

/**
 * Регистрирует модули, грузит плагины и собирает промпт-блоки.
 * Тонкий оркестратор: вся пошаговая логика — в приватных хелперах ниже,
 * порядок сайд-эффектов 1:1 с исходной монолитной версией.
 * @param input связный вход фазы (см. ModulesPhaseInput в state.ts).
 * @returns реестр модулей, exec-модуль и блоки системного промпта.
 */
export async function setupModulesPhase(input: ModulesPhaseInput): Promise<ModulesPhase> {
  const moduleRegistry = new ModuleRegistry();

  const core = await registerCoreModules(input, moduleRegistry);
  const languages = startLanguageModules(input, moduleRegistry);
  const startupCheckPromise = languages.startupCheck;
  registerModuleToolsAndPlugins(input, moduleRegistry, core);

  const promptBlocks = buildStaticPromptBlocks(input, moduleRegistry, core);
  dryRunStartupOverflow(input, promptBlocks);

  // План-блок удалён: мутирует каждую итерацию (статусы шагов), инвалидируя
  // локальный KV-кеш. Статус плана теперь инжектится в <system-summary>
  // после каждого пакета тулов.
  const getDynamicPromptBlocks = (): PromptBlock[] =>
    collectDynamicPromptBlocks(input, core.sessionModule);
  const lazyPromptBlocks = makeLazyPromptBlocks(startupCheckPromise);

  return {
    moduleRegistry,
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
  memoryStore: MemoryStore;
}

/** Exec + Session + Indexer + MCP (init с таймаутом) + Memory. */
async function registerCoreModules(
  input: ModulesPhaseInput,
  moduleRegistry: ModuleRegistry,
): Promise<CoreModules> {
  const { config, logger, dir, baseDir, hallucinationDetector } = input;

  const execModule = new ExecutionModule(
    baseDir,
    config.stuckThreshold,
    config.errorWebSearch?.threshold ?? 5,
  );
  // План следует за сессией: restorePlan поднимает legacy-глобальный план,
  // switchSession усыновляет его в слот стартовой сессии (или грузит её свой).
  // REPL рисует чеклист только на plan/todo-событиях — без спроса не печатаем.
  execModule.restorePlan();
  try {
    execModule.switchSession(input.sessionManager.getActive());
  } catch {
    // fail-open: без сессии трекер остаётся как поднял restorePlan
  }
  moduleRegistry.register(execModule);
  execModule.setHallucinationDetector(hallucinationDetector);

  const sessionModule = new SessionModule(input.sessionManager);
  moduleRegistry.register(sessionModule);

  moduleRegistry.register(input.indexerModule);

  const mcpModule = new MCPModule(config);
  try {
    // Ограничиваем init MCP, чтобы один медленный/висящий сервер не стопил boot
    // навсегда (B5): на таймауте — лог-и-дальше, MCP-тулы появятся поздно или
    // не появятся, вместо stall'а старта.
    await withTimeout(mcpModule.initialize(), 10_000);
  } catch (err) {
    logger.warn(
      `MCP init failed or timed out (${err instanceof Error ? err.message.slice(0, 120) : String(err)}) — continuing without MCP tools.`,
    );
  }
  moduleRegistry.register(mcpModule);

  // Общий глобальный стор памяти — один инстанс у модуля памяти и цикла,
  // поэтому UI (`mma web` `/memory`) читают/пишут живые данные.
  const memoryStore = new MemoryStore(join(dir, "memory"));
  const memoryModule = new MemoryModule(memoryStore);
  moduleRegistry.register(memoryModule);

  return { execModule, sessionModule, mcpModule, memoryStore };
}

/**
 * Языковые модули: Browser (опционально) + LSP + фоновый стартовый health-check.
 * @returns LSP-модуль (для web-вкладки) и промис стартовой проверки (без await —
 * резолвится к первому вводу).
 */
function startLanguageModules(
  input: ModulesPhaseInput,
  moduleRegistry: ModuleRegistry,
): { lspModule: LspModule; startupCheck: Promise<PromptBlock | null> } {
  const { config, logger, baseDir, exitOnComplete, pluginManager } = input;

  if (config.browser.enabled) {
    const browserModule = new BrowserModule();
    moduleRegistry.register(browserModule);
    registerBuiltinPlugin(pluginManager, browserModule.getPlugin());
  }

  const lspLogger = new FileOnlyLogger(logger);
  const lspModule = new LspModule(config.lsp, undefined, lspLogger);
  moduleRegistry.register(lspModule);
  registerBuiltinPlugin(pluginManager, lspModule.getPlugin());

  // LSP как внешний источник определений для `project_map symbol`: включается
  // только когда индекс не нашёл совпадений (спавн сервера не на каждый запрос).
  input.indexerModule.setSymbolProvider((query, language) =>
    lspModule.workspaceSymbol(query, baseDir, language),
  );

  // Стартовый health-check: сканируем проект на существующие ошибки, чтобы модель
  // знала baseline до работы. Пропуск для one-shot и тестов. Старт фоном (без
  // await), чтобы баннер REPL не ждал `npx tsc` по проекту; Agent дожидается
  // через `lazyPromptBlocks` перед первым LLM-вызовом (к вводу пользователя
  // в интерактиве уже резолвнут).
  const startupCheck =
    !isOneShotMode() && !exitOnComplete && process.env.NODE_ENV !== "test"
      ? runStartupHealthCheck(config.lsp ?? DEFAULT_LSP_CONFIG, baseDir, { logger: lspLogger })
      : Promise.resolve(null);
  return { lspModule, startupCheck };
}

/** Тулы модулей в реестр + builtin/external плагины в менеджер. */
function registerModuleToolsAndPlugins(
  input: ModulesPhaseInput,
  moduleRegistry: ModuleRegistry,
  core: CoreModules,
): void {
  const { logger, baseDir, toolRegistry, pluginManager, skillsModule, indexerModule } = input;

  const moduleTools = moduleRegistry.collectToolDefinitions();
  for (const tool of moduleTools) {
    toolRegistry.register(tool);
  }

  registerBuiltinPlugin(pluginManager, core.execModule.getPlugin());
  registerBuiltinPlugin(pluginManager, core.sessionModule.getPlugin());
  registerBuiltinPlugin(pluginManager, skillsModule.getPlugin());
  registerBuiltinPlugin(pluginManager, indexerModule.getPlugin());
  registerBuiltinPlugin(pluginManager, core.mcpModule.getPlugin());

  pluginManager.register(lintOnWritePlugin);
  pluginManager.register(notifyPlugin);

  const pluginLoader = new PluginLoader();
  const globalPluginsDir = resolveGlobalPluginsDir();
  const projectPluginsDir = join(projectMmaDir(baseDir), "plugins");
  const mmaVersion = readMmaVersion();
  pluginLoader.loadFromDir(globalPluginsDir, pluginManager, logger, {
    source: "global",
    mmaVersion,
  });
  pluginLoader.loadFromDir(projectPluginsDir, pluginManager, logger, {
    source: "project",
    mmaVersion,
  });
}

/**
 * Статичные промпт-блоки: systemInfo + реестреые + AGENTS.md + plan-напоминание.
 * Заодно вешает onCompact и провайдер сводки плана (состояние — в замыканиях
 * менеджера контекста, порядок 1:1 с исходником).
 */
function buildStaticPromptBlocks(
  input: ModulesPhaseInput,
  moduleRegistry: ModuleRegistry,
  core: CoreModules,
): PromptBlock[] {
  const { config, baseDir, dir, noAgentsMd, sessionManager, contextManager, systemInfoPrompt } =
    input;

  contextManager.onCompact = (summary) => {
    const meta = sessionManager.getActiveMeta();
    if (!meta || !config.session.autoSave) return;
    sessionManager.appendMessage({
      role: summary.role,
      content: summary.content,
      name: summary.name,
      timestamp: new Date().toISOString(),
    });
  };

  // Активный план (id, прогресс, текущий шаг) — в сводку компакции, чтобы 9B
  // модель не пересоздавала план с нуля сразу после неё (наблюдалось:
  // ses_msvuao0h — plan_e07pb2 (1/6) выкинут ради свежего plan_xzq9xe той же
  // итерацией, где старый план ещё был виден).
  contextManager.setPlanSummaryProvider(() => core.execModule.getPlanSummary());

  const agentsMdBlocks = loadAgentsMdBlocks(baseDir, dir, noAgentsMd === true);

  return [
    systemInfoPrompt,
    ...moduleRegistry.collectPromptBlocks(["indexer", "session"]),
    ...agentsMdBlocks,
    // Статичное напоминание о плане: всегда в наличии, чтобы модель проверяла
    // активный план до создания нового (даже на первой итерации, до появления
    // <system-summary>).
    {
      content:
        "[Plan Reminder] An active plan may exist for this session. Before creating a new plan, check with `plan show`. If a plan is active, continue it — do NOT create a new plan.",
      priority: "high",
      essential: false,
      estimatedTokens: 50,
    },
  ];
}

/**
 * Стартовый dry-run переполнения (баннер, A3): тот же набор блоков, что возьмёт
 * первая сборка Agent (статика + скиллы + карта + скрытые тулы), наружу —
 * невместившиеся instructions/project-map. Agent сожмёт их перед первым
 * LLM-вызовом; варнинг говорит ПОЛЬЗОВАТЕЛЮ почему и как вернуть полный текст.
 */
function dryRunStartupOverflow(input: ModulesPhaseInput, promptBlocks: PromptBlock[]): void {
  const { config, logger, dir, toolRegistry, activeToolTags, skillsModule, indexerModule } = input;

  const dynamicBlocks: PromptBlock[] = [];
  const skillsBlock = skillsModule.getSystemPromptBlock();
  if (skillsBlock) dynamicBlocks.push(skillsBlock);
  const mapBlock = indexerModule.getSystemPromptBlock();
  if (mapBlock) dynamicBlocks.push(mapBlock);
  const hiddenToolsBlock = buildHiddenToolsBlock(toolRegistry.getAll(), activeToolTags);
  if (hiddenToolsBlock) {
    dynamicBlocks.push({
      content: hiddenToolsBlock,
      priority: "low",
      essential: false,
      estimatedTokens: estimateTokens(hiddenToolsBlock),
    });
  }
  const systemBudget = Math.floor(config.contextWindow * config.contextBudget.systemPrompt);
  const dry = dryRunOverflow([...promptBlocks, ...dynamicBlocks], systemBudget);
  if (dry.overflow.length === 0) return;
  const overflowTokens = dry.overflow.reduce((s, b) => s + b.estimatedTokens, 0);
  const needed = dry.includedTokens + overflowTokens;
  const hint = overflowHint(config, dir, needed);
  for (const b of dry.overflow) {
    logger.warn(
      t("prompt.overflow.startup", {
        block: b.kind === "instructions" ? "AGENTS.md" : "project map",
        original: String(b.estimatedTokens),
        needed: String(needed),
        budget: String(systemBudget),
        hint,
      }),
    );
  }
}

/**
 * Динамические блоки (skills/сессия/карта/скрытые тулы) — собираются свежими
 * при каждом вызове. Мета сессии — здесь, а не при bootstrap: сессия создаётся
 * при bootstrap с messageCount 0, и статичный сбор всегда давал бы null.
 * Контент стабилен на сессию (без per-turn полей) ради prefix KV-кеша.
 */
function collectDynamicPromptBlocks(
  input: ModulesPhaseInput,
  sessionModule: SessionModule,
): PromptBlock[] {
  const { toolRegistry, activeToolTags, toolCtx, skillsModule, indexerModule } = input;
  const blocks: PromptBlock[] = [];
  const skillsBlock = skillsModule.getSystemPromptBlock();
  if (skillsBlock) blocks.push(skillsBlock);
  const sessionBlock = sessionModule.getSystemPromptBlock();
  if (sessionBlock) blocks.push(sessionBlock);
  const mapBlock = indexerModule.getSystemPromptBlock();
  if (mapBlock) blocks.push(mapBlock);
  const hiddenToolsBlock = toolCtx.toolAllowlist
    ? null
    : buildHiddenToolsBlock(toolRegistry.getAll(), activeToolTags);
  if (hiddenToolsBlock) {
    blocks.push({
      content: hiddenToolsBlock,
      priority: "low",
      essential: false,
      estimatedTokens: estimateTokens(hiddenToolsBlock),
    });
  }
  return blocks;
}

/** Ленивые блоки: фоновая стартовая проверка, мемоизированная первым вызовом. */
function makeLazyPromptBlocks(
  startupCheckPromise: Promise<PromptBlock | null>,
): () => Promise<PromptBlock[]> {
  let startupCheckBlock: PromptBlock | null = null;
  return async (): Promise<PromptBlock[]> => {
    if (startupCheckBlock) return [startupCheckBlock];
    startupCheckBlock = (await startupCheckPromise) ?? null;
    return startupCheckBlock ? [startupCheckBlock] : [];
  };
}
