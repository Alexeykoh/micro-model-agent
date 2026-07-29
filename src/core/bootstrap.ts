import { loadConfig } from '../config/config'
import { Logger } from '../logger/app-logger'
import { OpenAICompatProvider } from '../llm/openai-compat'
import { ToolRegistry, registerAllTools } from '../tools/index'
import { ToolExecutor } from '../tools/executor'
import { ModuleRegistry } from '../modules/registry'
import { PluginManager } from '../modules/plugins/manager'
import { ContextManager } from '../modules/context/manager'
import { HallucinationDetector } from '../modules/hallucination/detector'
import { ExecutionModule } from '../modules/execution/module'
import { SessionStore, SessionManager, SessionModule } from '../modules/session/index'
import { UserProfile } from '../modules/user-profile/profile'
import { Agent } from './agent'
import { homedir } from 'os'
import { join } from 'path'
import type { AgentDeps } from './agent'
import type { ToolContext } from '../tools/types'
import type { PromptBlock } from './types'
import type { AppConfig } from '../config/types'

function buildSystemInfo(config: AppConfig, baseDir: string, profileCompressed: string): string {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
  return [
    `You are MMA v2, an AI coding agent for small models (${config.model}).`,
    `Date: ${now}`,
    `Workspace: ${baseDir}`,
    `${profileCompressed}`,
    `Reply in the user's language. Use tools for filesystem, bash, web access.`,
  ].join('\n')
}

export interface BootstrapResult {
  agent: Agent
  config: AppConfig
  logger: Logger
  sessionManager: SessionManager
}

export function bootstrap(configDir?: string, projectDir?: string): BootstrapResult {
  const dir = configDir || join(homedir(), '.mma')
  const projectConfigPath = projectDir ? join(projectDir, '.mmarc.json') : join(process.cwd(), '.mmarc.json')

  const config = loadConfig({ configDir: dir, projectConfigPath })

  const logger = new Logger(config.logLevel as any)
  logger.setLogDir(join(dir, 'logs'))
  logger.debug('MMA bootstrap', { version: config.version, model: config.model })

  const profile = new UserProfile(join(dir))
  profile.load() || profile.collect()
  profile.save()

  const llmProvider = new OpenAICompatProvider({
    model: config.model,
    baseUrl: config.provider.baseUrl,
    apiKey: config.provider.apiKey,
    contextWindow: config.contextWindow,
  })

  const toolRegistry = new ToolRegistry()
  registerAllTools(toolRegistry)

  const pluginManager = new PluginManager()

  const baseDir = projectDir || process.cwd()

  const systemInfoPrompt: PromptBlock = {
    content: buildSystemInfo(config, baseDir, profile.compress()),
    priority: 'critical',
    essential: true,
    estimatedTokens: 120,
  }

  const sessionDir = join(dir, 'sessions')
  const sessionStore = new SessionStore(sessionDir)
  sessionStore.init()
  const sessionManager = new SessionManager(sessionStore, {
    model: config.model,
    contextWindow: config.contextWindow,
    projectDir: baseDir,
    maxSessions: config.session.maxSessions,
  })

  const toolCtx: ToolContext = {
    config,
    baseDir,
    logger,
    sessionHistory: {
      append: async (type: string, content: unknown) => {
        const meta = sessionManager.getActiveMeta()
        if (!meta) return
        sessionManager.appendMessage({
          role: 'tool',
          content: typeof content === 'string' ? content : JSON.stringify(content),
          name: type,
          timestamp: new Date().toISOString(),
        })
      },
    },
  }

  const toolExecutor = new ToolExecutor(toolRegistry, toolCtx, pluginManager)

  const contextManager = new ContextManager(config.contextWindow)

  const hallucinationDetector = new HallucinationDetector()

  const moduleRegistry = new ModuleRegistry()

  const execModule = new ExecutionModule(baseDir, config.stuckThreshold)
  moduleRegistry.register(execModule)

  const sessionModule = new SessionModule(sessionManager)
  moduleRegistry.register(sessionModule)

  const plugin = execModule.getPlugin()
  if (plugin) {
    pluginManager.register(plugin)
  }

  const sessionPlugin = sessionModule.getPlugin()
  if (sessionPlugin) {
    pluginManager.register(sessionPlugin)
  }

  contextManager.onCompact = (messages) => {
    const meta = sessionManager.getActiveMeta()
    if (!meta || !config.session.autoSave) return
    for (const msg of messages) {
      sessionManager.appendMessage({
        role: msg.role,
        content: msg.content,
        name: msg.name,
        timestamp: new Date().toISOString(),
      })
    }
  }

  const promptBlocks: PromptBlock[] = [
    systemInfoPrompt,
    ...moduleRegistry.collectPromptBlocks(),
  ]

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
  }

  const agent = new Agent(agentDeps)

  return { agent, config, logger, sessionManager }
}
