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
import { IndexerModule } from "../modules/indexer/index";
import { MCPModule } from "../modules/mcp/index";
import { setLocale } from "../i18n/index";
import { Agent } from "./agent";
import { homedir } from "os";
import { join } from "path";
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
    `Reply in the user's language. Use tools for filesystem, bash, web access.`,
    `When the task is ambiguous or has multiple reasonable options, ask the user via the "question" tool instead of guessing.`,
    `When you need to act, call a tool immediately. Do not describe your plans in text — use tools to perform operations.`,
    `After every tool call, check whether the user's request is fully satisfied. If any files, commands, or checks are still missing, call the next needed tool right away. Do not stop with an empty or "done" response until the task is complete.`,
    `If you create a directory, continue creating the files that belong inside it. A created folder alone is not a completed task.`,
    `If a tool call fails (e.g., a skill is too large), try an alternative approach or continue without it. Do not reply with empty text when the task is unfinished.`,
    ``,
    `Design principles — apply them automatically without naming them:`,
    `- Do not add code, files, or abstractions that are not needed right now (YAGNI — You Ain't Gonna Need It). If something is not required by the current task, omit it.`,
    `- Prefer simple, straightforward solutions over clever or complex ones (KISS — Keep It Simple, Stupid). Flat code beats nested, minimal config beats flexible, explicit beats generic.`,
    `- Do not duplicate code, logic, or configuration (DRY — Don't Repeat Yourself). Extract shared logic into a single place, reuse existing utilities and patterns before writing new ones.`,
  ];

  if (isWin) {
    lines.push(
      `OS-specific: You are on Windows. Do not use Unix-only command flags like "mkdir -p". Use the create_dir tool to create directories.`,
    );
  }

  if (config.autoPlan) {
    lines.push(
      ``,
      `Plan rule: For any task with 2+ steps, create a plan first using the "plan" tool. After each step, call "plan update" to mark progress. Stay focused on the current step.`,
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
}

export async function bootstrap(
  configDir?: string,
  projectDir?: string,
): Promise<BootstrapResult> {
  const dir = configDir || join(homedir(), ".mma");
  const projectConfigPath = projectDir
    ? join(projectDir, ".mmrc")
    : join(process.cwd(), ".mmrc");

  const config = loadConfig({ configDir: dir, projectConfigPath });
  setLocale(config.locale);

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
  });

  const baseDir = projectDir || process.cwd();

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
  });

  if (config.session.autoSave && !sessionManager.getActive()) {
    sessionManager.create();
  }

  const contextManager = new ContextManager(
    config.contextWindow,
    config.contextBudget,
  );

  const toolCtx: ToolContext = {
    config,
    baseDir,
    logger,
    contextManager,
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
  };

  const toolExecutor = new ToolExecutor(toolRegistry, toolCtx, pluginManager);
  (toolCtx as any).llmProvider = llmProvider;
  (toolCtx as any).toolExecutor = toolExecutor;

  const hallucinationDetector = new HallucinationDetector();
  const factualCheck = hallucinationDetector.getFactualCheck();
  toolCtx.trackReadPath = (p) => factualCheck.trackReadPath(p);
  toolCtx.trackCreatedPath = (p) => factualCheck.trackCreatedPath(p);

  const moduleRegistry = new ModuleRegistry();

  const execModule = new ExecutionModule(baseDir, config.stuckThreshold);
  moduleRegistry.register(execModule);

  const sessionModule = new SessionModule(sessionManager);
  moduleRegistry.register(sessionModule);

  moduleRegistry.register(skillsModule);
  moduleRegistry.register(indexerModule);

  const mcpModule = new MCPModule(config);
  await mcpModule.initialize();
  moduleRegistry.register(mcpModule);

  if (config.browser.enabled) {
    const browserModule = new BrowserModule();
    moduleRegistry.register(browserModule);
    const browserPlugin = browserModule.getPlugin();
    if (browserPlugin) {
      browserPlugin.isBuiltin = true;
      pluginManager.register(browserPlugin);
    }
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
  const userPluginsDir = join(dir, "plugins");
  pluginLoader.loadFromDir(userPluginsDir, pluginManager, logger);

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
    sessionManager,
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
  };
}
