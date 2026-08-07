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
import {
  SkillsLoader,
  SkillsMatcher,
  SkillsModule,
} from "../modules/skills/index";
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
  const lines = [
    `You are MMA v2, an AI coding agent for small models (${config.model}).`,
    `Date: ${now}`,
    `Workspace: ${baseDir}`,
    `${profileCompressed}`,
    `Reply in the user's language. Use tools for: read/write/edit/delete files, search (glob/grep), shell commands (bash), web access (web_search, web_fetch), subagents, browser, MCP.`,
    `Use tools when needed — explain briefly what you're doing if it's not obvious.`,
    `If a tool call fails, analyze the error and correct the call — try up to 2 times with different approaches before asking the user for help.`,
    ``,
    `Design principles:`,
    `- YAGNI: Do not add code, files, or abstractions not needed right now.`,
    `- KISS: Prefer simple, straightforward solutions over clever or complex ones.`,
    `- DRY: Do not duplicate code, logic, or configuration — reuse existing utilities and patterns.`,
  ];

  if (isWin) {
    lines.push(
      ``,
      `Windows environment — use Windows-compatible commands (shell is cmd.exe, not PowerShell):`,
      `- Use "dir" instead of "ls". Use "dir /b" for bare listing. For file listings prefer the list_dir tool.`,
      `- Use "type" instead of "cat". For reading files prefer the read_file tool.`,
      `- Use "cd" instead of "pwd". Use "echo %cd%" to print working directory.`,
      `- Use "copy" instead of "cp", "move" instead of "mv", "del" instead of "rm".`,
      `- Do not use "mkdir -p" — Windows mkdir creates intermediate dirs by default. Use the create_dir tool instead.`,
      `- Do not use "head" or "tail" — they are Unix commands. Use the read_file tool with offset/limit instead.`,
      `- Do not use "grep" — use the grep tool instead. Do not use PowerShell cmdlets (Get-Content, Select-Object, cat) in bash — the shell is cmd.exe.`,
      `- Use forward slashes (/) or escaped backslashes (\\\\) in file paths.`,
      `- Your working directory is: ${baseDir}`,
    );
  }

  lines.push(
    ``,
    `Bash tool rules:`,
    `- Use the "workdir" parameter to run commands in a specific directory. Prefer workdir over "cd dir && cmd" chaining.`,
    `- Run one command per tool call. Split multi-step shell operations into separate bash calls.`,
    `- Dev servers, watchers and other long-running processes: pass "background: true" to get a process id immediately. Without it, any command still running after a few seconds is automatically moved to the background — check output with process_log.`,
  );

  lines.push(
    ``,
    `=== DEVELOPMENT RULES — follow these strictly ===`,
    ``,
    `1. DEPENDENCIES FIRST: Before writing any source code, ALWAYS install project dependencies (e.g., "npm install", "pip install -r requirements.txt", "cargo build", "go mod tidy"). Verify the package manager's lock file or dependency directory exists. Never write code that imports/uses packages that aren't installed yet.`,
    `2. TOOLKIT/FWK FIRST: If the task specifies a framework or UI library, initialize and configure it BEFORE writing application code. Run its project init command first, then add components/modules. Never write your own version of what the framework already provides.`,
    `3. ONE STEP AT A TIME: Follow the plan sequentially. Complete step N before starting step N+1. When a step is done: verify the deliverables exist and have real content (not empty), then call "plan update step=N status=done". Do not redo completed work.`,
    `4. VERIFY YOUR WORK: After creating/modifying files, verify they exist on disk. After installing dependencies, verify the package manager completed successfully. After any command, check its output for errors. Don't assume operations succeeded.`,
    `5. NO PREMATURE WORK: Do not create files for future steps. Do not add imports/references to packages or modules that haven't been installed yet. Do not reference files or components that don't exist yet. Build incrementally — one layer at a time.`,
    `6. WHEN STUCK: If a command fails 2+ times, STOP and try a different approach. Write files directly instead of using commands. Ask the user for help. Never repeat the same failing command more than twice.`,
    ``,
    `=== PLAN QUALITY RULES — your plan MUST follow these ===`,
    ``,
    `- Each step must describe CONCRETE deliverables: exact filenames with paths, exact packages to install, exact CLI commands to run. Avoid vague steps — be specific.`,
    `- A step like "Настройка проекта" or "Setup the project" is too vague — describe what exactly needs to be configured or set up.`,
    `- A step like "Создать src/components/Header.tsx с навигацией и логотипом, добавить в src/App.tsx импорт <Header />" is GOOD.`,
    `- Include file extensions (.tsx, .css, .json) and directory paths. Every step must mention at least one file or command.`,
    `- The plan must cover EVERYTHING needed: init → deps → framework setup → code → verification.`,
    `- Number of steps: 5-8 for a typical task. Too few means you're being vague. Too many means you're over-splitting.`,
  );

  if (config.autoPlan) {
    lines.push(
      ``,
      `Plan rule (MANDATORY): For ANY task that requires creating files, installing packages, or multiple actions — you MUST create a plan using the "plan" tool BEFORE starting work. Each step must describe a concrete deliverable (specific files to create, packages to install, commands to run). Do not combine unrelated work into one step.`,
    );
  }

  const hasMCP =
    config.mcpServers &&
    Object.values(config.mcpServers).some((s) => s.enabled !== false);
  if (hasMCP) {
    lines.push(
      ``,
      `MCP servers are available. Use the named MCP tools (prefixed with mcp__) to query external services.`,
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

  const skillsMatcher = new SkillsMatcher();
  const skillsBudget = Math.floor(config.contextWindow * 0.1);
  const skillsModule = new SkillsModule(
    availableSkills,
    skillsMatcher,
    skillsBudget,
  );

  const toolRegistry = new ToolRegistry();
  registerAllTools(toolRegistry, skillsModule);

  const pluginManager = new PluginManager();

  const systemInfoPrompt: PromptBlock = {
    content: buildSystemInfo(config, baseDir, profile.compress()),
    priority: "critical",
    essential: true,
    estimatedTokens: 250,
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
  execModule.restorePlan();
  moduleRegistry.register(execModule);

  const sessionModule = new SessionModule(sessionManager);
  moduleRegistry.register(sessionModule);

  moduleRegistry.register(skillsModule);
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
  const projectPluginsDir = join(dir, ".mma", "plugins");
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
      const planBlock = execModule.getSystemPromptBlock();
      return planBlock ? [planBlock] : [];
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
