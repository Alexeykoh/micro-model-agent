import { loadConfig } from "../config/config";
import { Logger } from "../logger/app-logger";
import { ProviderManager } from "../modules/providers/index";
import { ModelLoader } from "../llm/model-loader";
import { ToolRegistry, registerAllTools } from "../tools/index";
import { buildHiddenToolsBlock } from "../tools/hidden-tools-block";
import { ToolExecutor } from "../tools/executor";
import { ModuleRegistry } from "../modules/registry";
import { PluginManager } from "../modules/plugins/manager";
import { PluginLoader } from "../modules/plugins/loader";
import { plugin as lintOnWritePlugin } from "../modules/plugins/builtin/lint-on-write";
import { plugin as notifyPlugin } from "../modules/plugins/builtin/notify";
import { ContextManager } from "../modules/context/manager";
import { TokenCounter } from "../llm/token-counter";
import { HallucinationDetector } from "../modules/hallucination/detector";
import { ExecutionModule } from "../modules/execution/module";
import { SessionStore, SessionManager, SessionModule } from "../modules/session/index";
import { UserProfile } from "../modules/user-profile/profile";
import { SkillsLoader, SkillsModule } from "../modules/skills/index";
import { BrowserModule } from "../modules/browser/index";
import { LspModule, DEFAULT_LSP_CONFIG } from "../modules/lsp/index";
import { runStartupHealthCheck } from "../modules/lsp/startup-check";
import { IndexerModule } from "../modules/indexer/index";
import { MCPModule } from "../modules/mcp/index";
import { MemoryModule } from "../modules/memory/module";
import { MemoryStore } from "../modules/memory/store";
import { setLocale } from "../i18n/index";
import { Agent } from "./agent";
import { homedir } from "os";
import { join, resolve } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";
import type { AgentDeps } from "./agent";
import type { ToolContext } from "../tools/types";
import type { PromptBlock } from "./types";
import type { AppConfig } from "../config/types";
import { readMmaVersion } from "./version";

export function buildSystemInfo(
  config: AppConfig,
  baseDir: string,
  profileCompressed: string,
): string {
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const isWin = profileCompressed.toLowerCase().includes("win32");
  const lines: string[] = [
    `You are MMA v2, an AI coding agent for small models (${config.model}). Date: ${now}. Workspace: ${baseDir}. ${profileCompressed}.`,
    `Reply in the user's language. Use tools for file ops (read/write/edit/delete), search (glob/grep), shell (bash), web, subagents, browser, MCP. Explain briefly if not obvious. On tool failure: analyze, fix the call, retry up to 2x with different approaches, then ask the user.`,
    `Design: YAGNI (no unneeded code), KISS (simple over clever), DRY (reuse existing utilities).`,
  ];

  if (isWin) {
    lines.push(
      `Windows (PowerShell): use list_dir/read_file/delete_file/create_dir tools instead of dir/type/del/mkdir. No PowerShell cmdlets (Get-Content, Select-Object, Write-Output), no head/tail/grep/cat. Use forward slashes in paths. CWD: ${baseDir}`,
    );
  }

  // MMA is a Bun-only project (package.json scripts, Bun API in code) — the
  // model should prefer bun over node/tsx/ts-node for running TypeScript
  // files and tests (observed: model wasted 10+ iterations installing tsx
  // instead of running `bun file.ts`).
  lines.push(
    `Runtime: Bun is available — run TypeScript directly with "bun <file.ts>" and tests with "bun test" (no tsx/ts-node/npm install needed for that).`,
  );

  lines.push(
    `Bash: use "workdir" param instead of "cd dir && cmd". One command per call. Long-running processes: pass "background: true" (id immediately), otherwise auto-backgrounded after a few seconds — check with process_log.`,
    `DEVELOPMENT RULES (strict): 1) install deps BEFORE writing source (npm/pip/cargo, verify lockfile exists; never import uninstalled packages); 2) framework/toolkit init BEFORE app code; 3) follow plan sequentially, after each step verify deliverables exist with real content, then "plan update step=N status=done"; 4) verify work on disk + command output — don't assume success; 5) no premature work (no files/imports for future steps); 6) stuck after 2+ failures: STOP, try a different approach, write files directly, ask the user.`,
    `VERIFY EVERY WRITE: after write_file or edit_file, if the tool result contains NO [LSP errors], [LSP warnings], [Syntax check failed], or [Project typecheck failed] feedback, call the "lsp_check" tool on the file you just wrote BEFORE marking the step done. Never assume a written file is valid — prove it.`,
    `PLAN QUALITY: each step = CONCRETE deliverables (exact file paths with extensions, exact packages, exact commands). Vague steps ("Setup the project") forbidden. Cover init → deps → framework → code → verification. 5-8 steps.`,
    `For "check/fix errors" tasks, each verification step must name the exact command that proves the errors are gone — "bun run build", "bun test", or the "lsp_check" tool — and the step is done only after that check reports clean.`,
  );

  if (config.autoPlan) {
    lines.push(
      `Plan rule (MANDATORY): any task creating files, installing packages, or requiring multiple actions MUST create a plan with the "plan" tool BEFORE starting. Each step = a concrete deliverable.`,
    );
  }

  // When a bug is described in terms of runtime behavior (what happens when
  // the app runs), the fix is only provable by REPRODUCING it — running the
  // app/build/browser and comparing against actual output. The model decides
  // when this applies (no keyword classification). Stale dev servers started
  // before a config/deps change keep the OLD pipeline in memory and still
  // throw the original error (observed: old vite on 5173-5176 kept failing
  // postcss after the fix was on disk, while a fresh server on 5177 was
  // clean) — the fix is only real when the USER's running server is clean.
  lines.push(
    `Runtime verification: when a bug is described in terms of runtime behavior (what happens when the app runs), reproduce it — run the app / build / browser tool — and confirm the fix against actual runtime output before calling "plan update step=N status=done". Check existing servers first with process_list/process_log: a stale dev server started BEFORE your change still runs the old pipeline and keeps failing even after the files on disk are fixed. Restart or kill it (process_kill) and verify the exact endpoint/port the user reported — a fresh server on a new port does NOT prove the user's error is gone.`,
  );

  const hasMCP =
    config.mcpServers && Object.values(config.mcpServers).some((s) => s.enabled !== false);
  if (hasMCP) {
    lines.push(
      `MCP servers are available — use the named MCP tools (prefixed mcp__) to query external services.`,
    );
  }

  return lines.join("\n");
}

export interface BootstrapResult {
  agent: Agent;
  config: AppConfig;
  logger: Logger;
  sessionManager: SessionManager;
  skillsModule: SkillsModule;
  pluginManager: PluginManager;
  /** Shared ToolContext; `sessionId`/`sessionContext` are live getters over
   *  the session manager, so a session switch is always reflected. */
  toolCtx: ToolContext;
  configDir: string;
  baseDir: string;
  noAgentsMd: boolean;
}

export async function bootstrap(
  configDir?: string,
  projectDir?: string,
  noAgentsMd?: boolean,
  exitOnComplete?: boolean,
): Promise<BootstrapResult> {
  const dir = configDir || join(homedir(), ".mma");
  const projectConfigPath = projectDir ? join(projectDir, ".mmrc") : join(process.cwd(), ".mmrc");

  const config = loadConfig({ configDir: dir, projectConfigPath });
  setLocale(config.locale);

  // Update global audit notifier with config
  try {
    const { globalAuditNotifier } = await import("../modules/security/audit-notifier");
    if (config.security?.auditNotifier) {
      globalAuditNotifier.updateConfig(
        config.security.auditNotifier as Partial<typeof config.security.auditNotifier>,
      );
    }
  } catch {
    // Ignore if audit notifier is not available
  }

  const logger = new Logger(config.logLevel as any);
  logger.setLogDir(join(dir, "logs"));
  logger.debug("MMA bootstrap", {
    version: config.version,
    model: config.model,
  });

  if (config.modelLoad.autoLoad) {
    const modelLoader = new ModelLoader(config.provider.baseUrl, logger);
    const loadResult = await modelLoader.ensureModelLoaded({
      model: config.model,
      contextLength: config.contextWindow,
      flashAttention: config.modelLoad.flashAttention,
      offloadKvCacheToGpu: config.modelLoad.offloadKvCacheToGpu,
      autoLoad: config.modelLoad.autoLoad,
    });

    if (!loadResult.success) {
      logger.warn(`Model auto-load failed: ${loadResult.error}. Continuing with manual load.`);
    } else if (loadResult.alreadyLoaded) {
      logger.debug(`Model ${config.model} already loaded`);
    } else {
      logger.info(`Model ${config.model} loaded in ${loadResult.loadTime}s`);
    }
  }

  const profile = new UserProfile(join(dir));
  profile.load() || profile.collect();
  profile.save();

  // Multi-provider manager (Phase 2). Built from the (possibly legacy flat)
  // config; the active provider is resolved through it. The initial provider
  // comes from the manager so the active entry is honored on startup.
  const providerManager = new ProviderManager(config.provider, {
    contextWindow: config.contextWindow,
    retry: config.retry,
    rateLimits: config.security?.rateLimits,
  });
  providerManager.setModel(config.model);
  const llmProvider = providerManager.active;

  const baseDir = projectDir ? resolve(projectDir) : process.cwd();

  const projectMapCacheDir = join(baseDir, ".mma");
  const indexerModule = new IndexerModule({
    baseDir,
    cacheDir: projectMapCacheDir,
  });
  try {
    await indexerModule.buildIndex();
  } catch (err: any) {
    logger.warn(`Project indexing failed: ${err.message}`);
  }

  const skillsLoader = new SkillsLoader();
  const builtinDir = join(import.meta.dirname, "skills", "builtin");
  const globalDir = join(homedir(), ".agents", "skills");
  const projectSkillsDir = join(baseDir, ".mma", "skills");
  const availableSkills = skillsLoader.loadFromAllSources(builtinDir, globalDir, projectSkillsDir);

  const skillsBudget = Math.floor(config.contextWindow * config.skills.budget);
  const skillsModule = new SkillsModule(availableSkills, skillsBudget);

  const toolRegistry = new ToolRegistry();
  registerAllTools(toolRegistry, skillsModule, {
    enableOnDemand: config.tools?.enableOnDemand,
  });

  const pluginManager = new PluginManager();

  const systemInfoContent = buildSystemInfo(config, baseDir, profile.compress());
  const systemInfoPrompt: PromptBlock = {
    content: systemInfoContent,
    priority: "critical",
    essential: true,
    estimatedTokens: Math.ceil(systemInfoContent.length / 4),
  };

  const agentsMdGlobal = join(dir, "AGENTS.md");
  if (!existsSync(agentsMdGlobal)) {
    writeFileSync(agentsMdGlobal, "", "utf-8");
  }

  const sessionDir = join(dir, "sessions");
  const sessionStore = new SessionStore(sessionDir);
  sessionStore.init();
  const sessionManager = new SessionManager(sessionStore, {
    model: config.model,
    contextWindow: config.contextWindow,
    projectDir: baseDir,
    maxSessions: config.session.maxSessions,
    isolation: config.sessionIsolation,
  });

  if (config.session.autoSave && !sessionManager.getActive()) {
    sessionManager.create();
  }

  const tokenCounter = new TokenCounter(config.model);

  // Mutable set of active tool tags, shared between the agent loop and the
  // `enable_tools` tool. The loop re-reads it every iteration to recompute the
  // LLM-visible tool set; enable_tools pushes tags into it. When on-demand
  // enabling is disabled the tag set stays empty, which restores the legacy
  // all-tools behavior (getAllForLLM returns everything for empty tags).
  const enableOnDemand = config.tools?.enableOnDemand !== false;
  const activeToolTags: string[] = enableOnDemand
    ? config.tools?.defaultTags
      ? [...config.tools.defaultTags]
      : []
    : [];

  const contextManager = new ContextManager(
    config.contextWindow,
    config.contextBudget,
    tokenCounter,
  );

  const toolCtx: ToolContext = {
    config,
    baseDir,
    logger,
    exitOnComplete,
    contextManager,
    activeToolTags,
    recursionDepth: 0,
    fileOperationsCount: 0,
    sessionHistory: {
      append: async (type: string, content: unknown) => {
        const meta = sessionManager.getActiveMeta();
        if (!meta) return;
        sessionManager.appendMessage({
          role: "tool",
          content: typeof content === "string" ? content : JSON.stringify(content),
          name: type,
          timestamp: new Date().toISOString(),
        });
      },
    },
    sessionLog: {
      plan: (event: string, detail: string, iteration?: number) => {
        sessionManager.appendLog({
          ts: new Date().toISOString(),
          type: "plan",
          tool: event,
          content: detail,
          ...(iteration !== undefined ? { iteration } : {}),
        });
      },
    },
  };

  // `sessionId`/`sessionContext` are exposed as LIVE getters over the session
  // manager instead of being captured once at bootstrap. Capturing the values
  // pinned them to the session active at startup, so after a REPL /new or
  // /resume the new session's audit.jsonl entries were tagged with the
  // PREVIOUS session's id (observed: ses_msyghz8w audit entries carrying
  // ses_msyg892p_78kqhc) while sessionHistory kept reading the live meta.
  // Everything that consumes ctx.sessionId — audit log, process registry,
  // file-ops counters — now always sees the session that is actually active.
  Object.defineProperty(toolCtx, "sessionId", {
    get: () => sessionManager.getActiveMeta()?.id,
    configurable: true,
  });
  Object.defineProperty(toolCtx, "sessionContext", {
    get: () => sessionManager.getSessionContext() ?? undefined,
    configurable: true,
  });

  const toolExecutor = new ToolExecutor(toolRegistry, toolCtx, pluginManager);
  toolCtx.llmProvider = llmProvider;
  toolCtx.toolExecutor = toolExecutor;

  const hallucinationDetector = new HallucinationDetector(baseDir, llmProvider);

  const moduleRegistry = new ModuleRegistry();

  const execModule = new ExecutionModule(
    baseDir,
    config.stuckThreshold,
    config.errorWebSearch?.threshold ?? 5,
  );
  const activeMeta = sessionManager.getActiveMeta();
  if (activeMeta && activeMeta.messageCount > 0) {
    execModule.restorePlan();
  }
  moduleRegistry.register(execModule);
  execModule.setHallucinationDetector(hallucinationDetector);

  const sessionModule = new SessionModule(sessionManager);
  moduleRegistry.register(sessionModule);

  moduleRegistry.register(indexerModule);

  const mcpModule = new MCPModule(config);
  await mcpModule.initialize();
  moduleRegistry.register(mcpModule);

  const memoryStore = new MemoryStore(join(dir, "memory"));
  const memoryModule = new MemoryModule(memoryStore);
  moduleRegistry.register(memoryModule);

  if (config.browser.enabled) {
    const browserModule = new BrowserModule();
    moduleRegistry.register(browserModule);
    const browserPlugin = browserModule.getPlugin();
    if (browserPlugin) {
      browserPlugin.isBuiltin = true;
      pluginManager.register(browserPlugin);
    }
  }

  const lspModule = new LspModule(config.lsp);
  moduleRegistry.register(lspModule);
  const lspPlugin = lspModule.getPlugin();
  if (lspPlugin) {
    lspPlugin.isBuiltin = true;
    pluginManager.register(lspPlugin);
  }

  // Startup health check: scan project for existing errors so the model
  // knows the baseline before it starts working. Skip for one-shot runs and
  // test environments. Started in the background (never awaited) so the REPL
  // banner is not blocked by `npx tsc` on the whole project; the Agent awaits
  // it before the first LLM call via `lazyPromptBlocks` (already resolved by
  // the time the user types in the interactive REPL).
  let startupCheckBlock: PromptBlock | null = null;
  const startupCheckPromise =
    !exitOnComplete && process.env.NODE_ENV !== "test"
      ? runStartupHealthCheck(config.lsp ?? DEFAULT_LSP_CONFIG, baseDir)
      : Promise.resolve(null);

  const moduleTools = moduleRegistry.collectToolDefinitions();
  for (const tool of moduleTools) {
    toolRegistry.register(tool);
  }

  const plugin = execModule.getPlugin();
  if (plugin) {
    plugin.isBuiltin = true;
    pluginManager.register(plugin);
  }

  const sessionPlugin = sessionModule.getPlugin();
  if (sessionPlugin) {
    sessionPlugin.isBuiltin = true;
    pluginManager.register(sessionPlugin);
  }

  const skillsPlugin = skillsModule.getPlugin();
  if (skillsPlugin) {
    skillsPlugin.isBuiltin = true;
    pluginManager.register(skillsPlugin);
  }

  const indexerPlugin = indexerModule.getPlugin();
  if (indexerPlugin) {
    indexerPlugin.isBuiltin = true;
    pluginManager.register(indexerPlugin);
  }

  const mcpPlugin = mcpModule.getPlugin();
  if (mcpPlugin) {
    mcpPlugin.isBuiltin = true;
    pluginManager.register(mcpPlugin);
  }

  pluginManager.register(lintOnWritePlugin);
  pluginManager.register(notifyPlugin);

  const pluginLoader = new PluginLoader();
  const globalPluginsDir = join(homedir(), ".mma", "plugins");
  const projectPluginsDir = join(baseDir, ".mma", "plugins");
  const mmaVersion = readMmaVersion();
  pluginLoader.loadFromDir(globalPluginsDir, pluginManager, logger, {
    source: "global",
    mmaVersion,
  });
  pluginLoader.loadFromDir(projectPluginsDir, pluginManager, logger, {
    source: "project",
    mmaVersion,
  });

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

  // Carry the active plan (id, progress, current step) into the compaction
  // summary so a 9B model doesn't re-create the plan from scratch right after
  // compaction (observed: ses_msvuao0h — plan_e07pb2 (1/6) discarded for a
  // fresh plan_xzq9xe the same iteration the old plan was still visible).
  contextManager.setPlanSummaryProvider(() => execModule.getPlanSummary());

  const agentsMdBlocks: PromptBlock[] = [];
  const skipAgentsMd = noAgentsMd === true;
  if (!skipAgentsMd) {
    const agentsMdCandidates = [
      join(baseDir, "AGENTS.md"),
      join(baseDir, ".mma", "AGENTS.md"),
      join(dir, "AGENTS.md"),
    ];
    for (const p of agentsMdCandidates) {
      if (existsSync(p)) {
        const content = readFileSync(p, "utf-8").trim();
        if (content) {
          agentsMdBlocks.push({
            content,
            priority: "high",
            essential: false,
            estimatedTokens: Math.ceil(content.length / 4),
          });
        }
      }
    }
  }

  const promptBlocks: PromptBlock[] = [
    systemInfoPrompt,
    ...moduleRegistry.collectPromptBlocks(["indexer"]),
    ...agentsMdBlocks,
  ];

  const agentDeps: AgentDeps = {
    config,
    llmProvider,
    toolExecutor,
    pluginManager,
    contextManager,
    hallucinationDetector,
    logger,
    baseDir,
    toolTags: activeToolTags,
    promptBlocks,
    getDynamicPromptBlocks: () => {
      const blocks: PromptBlock[] = [];
      const planBlock = execModule.getSystemPromptBlock();
      if (planBlock) blocks.push(planBlock);
      const skillsBlock = skillsModule.getSystemPromptBlock();
      if (skillsBlock) blocks.push(skillsBlock);
      const mapBlock = indexerModule.getSystemPromptBlock();
      if (mapBlock) blocks.push(mapBlock);
      const hiddenToolsBlock = buildHiddenToolsBlock(toolRegistry.getAll(), activeToolTags);
      if (hiddenToolsBlock) {
        blocks.push({
          content: hiddenToolsBlock,
          priority: "low",
          essential: false,
          estimatedTokens: Math.ceil(hiddenToolsBlock.length / 4),
        });
      }
      return blocks;
    },
    finalAudit: () => execModule.runFinalAudit(),
    lazyPromptBlocks: async () => {
      if (startupCheckBlock) return [startupCheckBlock];
      startupCheckBlock = (await startupCheckPromise) ?? null;
      return startupCheckBlock ? [startupCheckBlock] : [];
    },
    sessionManager,
    memoryStore,
    exitOnComplete,
  };

  const agent = new Agent(agentDeps);

  return {
    agent,
    config,
    logger,
    sessionManager,
    skillsModule,
    pluginManager,
    toolCtx,
    configDir: dir,
    baseDir,
    noAgentsMd: skipAgentsMd,
  };
}
