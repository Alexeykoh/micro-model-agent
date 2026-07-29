import type { LLMProvider } from '../llm/provider'
import type { ToolExecutor } from '../tools/executor'
import type { PluginManager } from '../modules/plugins/manager'
import type { ContextManager, Message } from '../modules/context/manager'
import type { HallucinationDetector } from '../modules/hallucination/detector'
import type { Logger } from '../logger/app-logger'
import type { AppConfig } from '../config/types'
import type { PromptBlock } from './types'
import type { ToolCall } from './types'
import type { SessionManager } from '../modules/session/manager'
import pc from 'picocolors'
import { PromptBuilder } from './prompt-builder'

const TOOL_RESULT_MAX_TOKENS_RATIO = 0.3
const TOOL_RESULT_ABSOLUTE_MAX_CHARS = 15000

export interface AgentDeps {
  config: AppConfig
  llmProvider: LLMProvider
  toolExecutor: ToolExecutor
  pluginManager: PluginManager
  contextManager: ContextManager
  hallucinationDetector: HallucinationDetector
  logger: Logger
  baseDir: string
  promptBlocks: PromptBlock[]
  sessionManager?: SessionManager
}

export interface AgentResult {
  success: boolean
  text: string
  error?: string
  iterationCount: number
  contextUsed?: number
  contextLimit?: number
}

export class Agent {
  private deps: AgentDeps
  private systemPromptAdded = false

  constructor(deps: AgentDeps) {
    this.deps = deps
  }

  private truncateToolOutput(output: string, budget: { history: number }, currentTokens: number): string {
    const remainingBudget = budget.history - currentTokens
    const maxCharsByBudget = Math.floor(remainingBudget * 0.5 * 2)
    const maxCharsByRatio = Math.floor(budget.history * TOOL_RESULT_MAX_TOKENS_RATIO * 2)
    const maxChars = Math.min(maxCharsByBudget, maxCharsByRatio, TOOL_RESULT_ABSOLUTE_MAX_CHARS)

    if (output.length <= maxChars) return output

    const truncated = output.slice(0, maxChars)
    const removedChars = output.length - maxChars
    return truncated + `\n\n[Truncated: ${Math.ceil(removedChars / 2)} tokens removed]`
  }

  async run(input: string, onChunk?: (chunk: string) => void, onMeta?: (meta: string) => void): Promise<AgentResult> {
    const { config, llmProvider, toolExecutor, pluginManager, contextManager, hallucinationDetector, logger, promptBlocks, sessionManager } = this.deps

    if (sessionManager && !sessionManager.getActive()) {
      sessionManager.create()
      logger.debug(`Session started: ${sessionManager.getActive()}`)
    }

    if (!this.systemPromptAdded) {
      const systemBudget = Math.floor(config.contextWindow * config.contextBudget.systemPrompt)
      const builder = new PromptBuilder(systemBudget)
      builder.addBlocks(promptBlocks)
      const { prompt: systemPrompt } = builder.build()
      contextManager.addMessage({ role: 'system', content: systemPrompt })
      this.systemPromptAdded = true
      pluginManager.runOnSessionStart({ logger, sessionManager: sessionManager?.getActiveMeta() })
    }

    contextManager.addMessage({ role: 'user', content: input })

    if (sessionManager) {
      sessionManager.appendMessage({ role: 'user', content: input, timestamp: new Date().toISOString() })
    }

    let iteration = 0
    let lastText = ''

    while (iteration < config.maxToolIterations) {
      iteration++

      pluginManager.runOnBeforeThink({ iteration, logger })

      if (contextManager.needsCompaction()) {
        contextManager.compact()
        logger.debug('Context compacted')
      }

      const currentTokens = contextManager.getEstimatedTokens()
      const budget = contextManager.getBudget()
      if (currentTokens > budget.history) {
        contextManager.compact()
        logger.warn(`Context overflow (${currentTokens} > ${budget.history}), forced compaction`)
      }

      const history = contextManager.getActiveHistory()

      const allTools = toolExecutor.getToolDefinitions()
      let textContent = ''
      let reasoningContent = ''
      const toolCalls: ToolCall[] = []
      let sawToolCall = false
      let emittedReasoning = false

      try {
        for await (const chunk of llmProvider.chat(history, allTools as any)) {
          if (chunk.type === 'text' && chunk.content) {
            if (emittedReasoning && !textContent) {
              onMeta?.('\n\n')
            }
            textContent += chunk.content
            onChunk?.(chunk.content)
          }
          if (chunk.type === 'reasoning' && chunk.content) {
            reasoningContent += chunk.content
            if (config.showReasoning) {
              onMeta?.(pc.dim(chunk.content))
              emittedReasoning = true
            }
          }
          if (chunk.type === 'tool_call' && chunk.toolCall) {
            sawToolCall = true
            onMeta?.('\n' + pc.dim(`[Using: ${chunk.toolCall.name}]`) + '\n')
            let parsedArgs: Record<string, unknown>
            try {
              parsedArgs = JSON.parse(chunk.toolCall.arguments)
            } catch {
              parsedArgs = {}
            }
            toolCalls.push({
              id: chunk.toolCall.id,
              name: chunk.toolCall.name,
              arguments: parsedArgs,
            })
          }
        }
      } catch (err: any) {
        logger.error(`LLM call failed: ${err.message}`)
        pluginManager.runOnError({ iteration, logger }, err)
        return { success: false, text: lastText, error: `LLM error: ${err.message}`, iterationCount: iteration }
      }

      if (sawToolCall) {
        for (const call of toolCalls) {
          const proceed = await pluginManager.runOnBeforeTool({ iteration, logger }, call)
          if (!proceed) {
            logger.warn(`Tool call blocked by plugin: ${call.name}`)
            contextManager.addMessage({
              role: 'tool',
              content: `Tool ${call.name} was blocked by policy`,
              name: call.name,
            })
            continue
          }

          const result = await toolExecutor.execute(call)
          const currentTokens = contextManager.getEstimatedTokens()
          const budget = contextManager.getBudget()
          const truncatedOutput = this.truncateToolOutput(result.output, budget, currentTokens)
          contextManager.addMessage({
            role: 'tool',
            content: truncatedOutput,
            name: call.name,
          })
          if (sessionManager && config.session.autoSave) {
            sessionManager.appendMessage({
              role: 'tool',
              content: truncatedOutput.slice(0, 500),
              name: call.name,
              timestamp: new Date().toISOString(),
            })
          }
          if (contextManager.needsCompaction()) {
            contextManager.compact()
            logger.debug('Context compacted after tool result')
          }
        }
        continue
      }

      const hallucinationResult = hallucinationDetector.validate(textContent)
      if (hallucinationResult.status === 'block') {
        logger.warn(`Response blocked: ${hallucinationResult.reason}`)
        return { success: false, text: lastText, error: `Response blocked: ${hallucinationResult.reason}`, iterationCount: iteration }
      }

      if (textContent || reasoningContent) {
        contextManager.addMessage({ role: 'assistant', content: textContent || reasoningContent })
        if (sessionManager && config.session.autoSave) {
          sessionManager.appendMessage({
            role: 'assistant',
            content: (textContent || reasoningContent).slice(0, 500),
            timestamp: new Date().toISOString(),
          })
        }
      }

      lastText = textContent

      if (!sawToolCall) {
        break
      }
    }

    const tokensUsed = contextManager.getEstimatedTokens()
    const budget = contextManager.getBudget()

    if (iteration >= config.maxToolIterations) {
      return { success: false, text: lastText, error: `Max iterations (${config.maxToolIterations}) reached`, iterationCount: iteration, contextUsed: tokensUsed, contextLimit: budget.history }
    }

    return { success: true, text: lastText, iterationCount: iteration, contextUsed: tokensUsed, contextLimit: budget.history }
  }

  clearContext(): void {
    this.deps.contextManager.clear()
    this.systemPromptAdded = false
  }

  setContext(messages: Array<{ role: string; content: string; name?: string }>): void {
    const { config, contextManager, promptBlocks } = this.deps
    contextManager.clear()
    const systemBudget = Math.floor(config.contextWindow * config.contextBudget.systemPrompt)
    const builder = new PromptBuilder(systemBudget)
    builder.addBlocks(promptBlocks)
    const { prompt: systemPrompt } = builder.build()
    contextManager.addMessage({ role: 'system', content: systemPrompt })
    this.systemPromptAdded = true
    for (const msg of messages) {
      if (msg.role === 'system') continue
      contextManager.addMessage({ role: msg.role as Message['role'], content: msg.content, name: msg.name })
    }
  }

  shutdown(): void {
    const { pluginManager, logger, sessionManager, contextManager } = this.deps
    contextManager.onCompact = null
    pluginManager.runOnSessionEnd({ logger, sessionManager: sessionManager?.getActiveMeta() })
  }
}
