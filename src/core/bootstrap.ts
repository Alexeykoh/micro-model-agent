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
import { Agent } from './agent'
import { homedir } from 'os'
import { join } from 'path'
import type { AgentDeps } from './agent'
import type { ToolContext } from '../tools/types'
import type { PromptBlock } from './types'
import type { AppConfig } from '../config/types'

export interface BootstrapResult {
  agent: Agent
  config: AppConfig
  logger: Logger
}

export function bootstrap(configDir?: string, projectDir?: string): BootstrapResult {
  const dir = configDir || join(homedir(), '.mma')
  const projectConfigPath = projectDir ? join(projectDir, '.mmarc.json') : join(process.cwd(), '.mmarc.json')

  const config = loadConfig({ configDir: dir, projectConfigPath })

  const logger = new Logger(config.logLevel as any)

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

  const toolCtx: ToolContext = {
    config,
    baseDir,
    logger,
  }

  const toolExecutor = new ToolExecutor(toolRegistry, toolCtx, pluginManager)

  const contextManager = new ContextManager(config.contextWindow)

  const hallucinationDetector = new HallucinationDetector()

  const moduleRegistry = new ModuleRegistry()

  const execModule = new ExecutionModule(baseDir, config.stuckThreshold)
  moduleRegistry.register(execModule)

  const plugin = execModule.getPlugin()
  if (plugin) {
    pluginManager.register(plugin)
  }

  const promptBlocks: PromptBlock[] = moduleRegistry.collectPromptBlocks()

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
  }

  const agent = new Agent(agentDeps)

  return { agent, config, logger }
}
