import { loadConfig } from "../config/config";
import { Logger } from "../logger/app-logger";
import { OpenAICompatProvider } from "../llm/openai-compat";
import { ModelLoader } from "../llm/model-loader";
import { ToolRegistry, registerAllTools } from "../tools/index";
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
import {
  SessionStore,
  SessionManager,
  SessionModule,
} from "../modules/session/index";
import { UserProfile } from "../modules/user-profile/profile";
import { SkillsLoader, SkillsModule } from "../modules/skills/index";
import { BrowserModule } from "../modules/browser/index";
import { LspModule } from "../modules/lsp/index";
import { IndexerModule } from "../modules/indexer/index";
import { MCPModule } from "../modules/mcp/index";
import { MemoryModule } from "../modules/memory/module";
import { setLocale } from "../i18n/index";
import { Agent } from "./agent";
import { homedir } from "os";
import { join, resolve } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";
import type { AgentDeps } from "./agent";
import type { ToolContext } from "../tools/types";
import type { PromptBlock } from "./types";
import type { AppConfig } from "../config/types";

function buildSystemInfo(
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

  lines.push(
    `Bash: use "workdir" param instead of "cd dir && cmd". One command per call. Long-running processes: pass "background: true" (id immediately), otherwise auto-backgrounded after a few seconds — check with process_log.`,
    `DEVELOPMENT RULES (strict): 1) install deps BEFORE writing source (npm/pip/cargo, verify lockfile exists; never import uninstalled packages); 2) framework/toolkit init BEFORE app code; 3) follow plan sequentially, after each step verify deliverables exist with real content, then "plan update step=N status=done"; 4) verify work on disk + command output — don't assume success; 5) no premature work (no files/imports for future steps); 6) stuck after 2+ failures: STOP, try a different approach, write files directly, ask the user.`,
    `PLAN QUALITY: each step = CONCRETE deliverables (exact file paths with extensions, exact packages, exact commands). Vague steps ("Setup the project") forbidden. Cover init → deps → framework → code → verification. 5-8 steps.`,
  );

  if (config.autoPlan) {
    lines.push(
      `Plan rule (MANDATORY): any task creating files, installing packages, or requiring multiple actions MUST create a plan with the "plan" tool BEFORE starting. Each step = a concrete deliverable.`,
    );
  }

  const hasMCP =
    config.mcpServers &&
    Object.values(config.mcpServers).some((s) => s.enabled !== false);
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
  const projectConfigPath = projectDir
    ? join(projectDir, ".mmrc")
    : join(process.cwd(), ".mmrc");

  const config = loadConfig({ configDir: dir, projectConfigPath });
  setLocale(config.locale);

  // Update global audit notifier with config
  try {
    const { globalAuditNotifier } =
      await import("../modules/security/audit-notifier");
    if (config.security?.auditNotifier) {
      globalAuditNotifier.updateConfig(
        config.security.auditNotifier as Partial<
          typeof config.security.auditNotifier
        >,
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
      logger.warn(
        `Model auto-load failed: ${loadResult.error}. Continuing with manual load.`,
      );
    } else if (loadResult.alreadyLoaded) {
      logger.debug(`Model ${config.model} already loaded`);
    } else {
      logger.info(`Model ${config.model} loaded in ${loadResult.loadTime}s`);
    }
  }

  const profile = new UserProfile(join(dir));
  profile.load() || profile.collect();
  profile.save();

  const llmProvider = new OpenAICompatProvider({
    model: config.model,
    baseUrl: config.provider.baseUrl,
    apiKey: config.provider.apiKey,
    contextWindow: config.contextWindow,
    retry: config.retry,
    rateLimits: config.security?.rateLimits,
  });

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
  const availableSkills = skillsLoader.loadFromAllSources(
    builtinDir,
    globalDir,
    projectSkillsDir,
  );

  const skillsBudget = Math.floor(config.contextWindow * config.skills.budget);
  const skillsModule = new SkillsModule(availableSkills, skillsBudget);

  const toolRegistry = new ToolRegistry();
  registerAllTools(toolRegistry, skillsModule);

  const pluginManager = new PluginManager();

  const systemInfoContent = buildSystemInfo(
    config,
    baseDir,
    profile.compress(),
  );
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
    sessionId: sessionManager.getActiveMeta()?.id,
    sessionContext: sessionManager.getSessionContext() ?? undefined,
    recursionDepth: 0,
    fileOperationsCount: 0,
    sessionHistory: {
      append: async (type: string, content: unknown) => {
        const meta = sessionManager.getActiveMeta();
        if (!meta) return;
        sessionManager.appendMessage({
          role: "tool",
          content:
            typeof content === "string" ? content : JSON.stringify(content),
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

  const toolExecutor = new ToolExecutor(toolRegistry, toolCtx, pluginManager);
  toolCtx.llmProvider = llmProvider;
  toolCtx.toolExecutor = toolExecutor;

  const hallucinationDetector = new HallucinationDetector(baseDir, llmProvider);

  const moduleRegistry = new ModuleRegistry();

  const execModule = new ExecutionModule(baseDir, config.stuckThreshold);
  const activeMeta = sessionManager.getActiveMeta();
  if (activeMeta && activeMeta.messageCount > 0) {
    execModule.restorePlan();
  }
  moduleRegistry.register(execModule);

  const sessionModule = new SessionModule(sessionManager);
  moduleRegistry.register(sessionModule);

  moduleRegistry.register(indexerModule);

  const mcpModule = new MCPModule(config);
  await mcpModule.initialize();
  moduleRegistry.register(mcpModule);

  const memoryModule = new MemoryModule(join(dir, "memory"));
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
  pluginLoader.loadFromDir(globalPluginsDir, pluginManager, logger);
  pluginLoader.loadFromDir(projectPluginsDir, pluginManager, logger);

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
    ...moduleRegistry.collectPromptBlocks(),
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
    promptBlocks,
    getDynamicPromptBlocks: () => {
      const blocks: PromptBlock[] = [];
      const planBlock = execModule.getSystemPromptBlock();
      if (planBlock) blocks.push(planBlock);
      const skillsBlock = skillsModule.getSystemPromptBlock();
      if (skillsBlock) blocks.push(skillsBlock);
      return blocks;
    },
    finalAudit: () => execModule.runFinalAudit(),
    sessionManager,
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
    configDir: dir,
    baseDir,
    noAgentsMd: skipAgentsMd,
  };
}
