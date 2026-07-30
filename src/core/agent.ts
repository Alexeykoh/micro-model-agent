import type { LLMProvider } from '../llm/provider'
import type { ToolExecutor } from '../tools/executor'
import type { PluginManager } from '../modules/plugins/manager'
import type { ContextManager, Message } from '../modules/context/manager'
import type { HallucinationDetector } from '../modules/hallucination/detector'
import type { Logger } from '../logger/app-logger'
import type { AppConfig } from '../config/types'
import type { ToolScope } from '../tools/types'
import type { PromptBlock } from './types'
import type { ToolCall } from './types'
import type { SessionManager } from '../modules/session/manager'
import { t } from '../i18n/index'
import pc from 'picocolors'
import { PromptBuilder } from './prompt-builder'
import { OrchestratorClient } from '../llm/orchestrator'
import { validatePlan, applyAutoFixes } from '../modules/execution/plan-validator'
import { MoEExecutor } from '../modules/execution/moe-executor'
import { StepVerifier } from '../modules/execution/verifier'

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
  scope?: ToolScope
  toolTags?: string[]
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

  private setScope(): void {
    const executor = this.deps.toolExecutor as any
    if (executor && executor.ctx && this.deps.scope) {
      executor.ctx.scope = this.deps.scope
    }
  }

  private truncateToolOutput(output: string, budget: { history: number }, currentTokens: number): string {
    const remainingBudget = budget.history - currentTokens
    const maxCharsByBudget = Math.floor(remainingBudget * 0.5 * 2)
    const maxCharsByRatio = Math.floor(budget.history * TOOL_RESULT_MAX_TOKENS_RATIO * 2)
    const maxChars = Math.min(maxCharsByBudget, maxCharsByRatio, TOOL_RESULT_ABSOLUTE_MAX_CHARS)

    if (output.length <= maxChars) return output

    const truncated = output.slice(0, maxChars)
    const removedChars = output.length - maxChars
    return truncated + `\n\n${t('tool.truncated', { tokens: Math.ceil(removedChars / 2) })}`
  }

  async run(input: string, onChunk?: (chunk: string) => void, onMeta?: (meta: string) => void): Promise<AgentResult> {
    this.setScope()
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
      sessionManager.appendLog({ ts: new Date().toISOString(), type: 'user', content: input })
    }

    if (config.moe?.enabled) {
      return this.runWithMoE(input, onChunk, onMeta)
    }

    return this.executeSingleAgentLoop(input, onChunk, onMeta)
  }

  private async executeSingleAgentLoop(input: string, onChunk?: (chunk: string) => void, onMeta?: (meta: string) => void): Promise<AgentResult> {
    const { config, llmProvider, toolExecutor, pluginManager, contextManager, hallucinationDetector, logger, sessionManager } = this.deps

    let iteration = 0
    let lastText = ''
    let hallucinationRetries = 0
    const MAX_HALLUCINATION_RETRIES = 3

    while (iteration < config.maxToolIterations) {
      iteration++

      pluginManager.runOnBeforeThink({ iteration, logger, lastUserMessage: input, contextManager, onMeta })

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

      const allTools = toolExecutor.getToolDefinitions(this.deps.toolTags)
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
            const friendlyKey = `tool.friendly.${chunk.toolCall.name}`
            const label = t(friendlyKey) !== friendlyKey ? t(friendlyKey) : chunk.toolCall.name
            onMeta?.('\n' + pc.dim(t('tool.using', { label })) + '\n')
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
        if (sessionManager) {
          sessionManager.appendLog({ ts: new Date().toISOString(), type: 'error', content: err.message })
        }
        pluginManager.runOnError({ iteration, logger }, err)
        return { success: false, text: lastText, error: t('error.llm', { message: err.message }), iterationCount: iteration }
      }

      if (sawToolCall) {
        for (const call of toolCalls) {
          this.setScope()
          const startTime = Date.now()
          pluginManager.runOnToolCall({ toolName: call.name, args: call.arguments })
          if (sessionManager) {
            sessionManager.appendLog({ ts: new Date().toISOString(), type: 'tool_call', tool: call.name, args: call.arguments })
          }
          const result = await toolExecutor.execute(call)
          const duration = Date.now() - startTime
          if (result.display) {
            onMeta?.('\n' + result.display + '\n')
          }
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
            sessionManager.appendLog({ ts: new Date().toISOString(), type: 'tool_result', tool: call.name, success: result.success, content: result.output.slice(0, 1000), duration })
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
        return { success: false, text: lastText, error: t('error.response_blocked', { reason: hallucinationResult.reason || '' }), iterationCount: iteration }
      }
      if (hallucinationResult.status === 'warn') {
        logger.warn(`Hallucination warning: ${hallucinationResult.reason}`)
        const warnPrefix = t('hall.uncertainty_prefix')
        if (onChunk) {
          onChunk(warnPrefix)
        }
        lastText = warnPrefix + lastText
      }
      if (hallucinationResult.status === 'retry') {
        if (hallucinationRetries >= MAX_HALLUCINATION_RETRIES) {
          logger.warn(`Max hallucination retries (${MAX_HALLUCINATION_RETRIES}) reached, proceeding with response`)
          break
        }
        hallucinationRetries++
        logger.warn(`Hallucination retry (${hallucinationRetries}/${MAX_HALLUCINATION_RETRIES}): ${hallucinationResult.reason}`)
        if (textContent) {
          contextManager.addMessage({ role: 'assistant', content: textContent })
        }
        contextManager.addMessage({
          role: 'system',
          content: `[Retry context: ${hallucinationResult.reason}. Please verify your response.]`,
        })
        continue
      }

      if (textContent) {
        contextManager.addMessage({ role: 'assistant', content: textContent })
        if (sessionManager && config.session.autoSave) {
          sessionManager.appendMessage({
            role: 'assistant',
            content: textContent.slice(0, 500),
            timestamp: new Date().toISOString(),
          })
        }
      }
      if (sessionManager && (textContent || reasoningContent)) {
        sessionManager.appendLog({ ts: new Date().toISOString(), type: 'assistant', content: textContent || reasoningContent })
      }

      lastText = textContent

      if (!sawToolCall) {
        break
      }
    }

    const tokensUsed = contextManager.getEstimatedTokens()
    const budget = contextManager.getBudget()

    if (iteration >= config.maxToolIterations) {
      return { success: false, text: lastText, error: t('error.max_iters', { max: config.maxToolIterations }), iterationCount: iteration, contextUsed: tokensUsed, contextLimit: budget.history }
    }

    return { success: true, text: lastText, iterationCount: iteration, contextUsed: tokensUsed, contextLimit: budget.history }
  }

  private async runWithMoE(input: string, _onChunk?: (chunk: string) => void, onMeta?: (meta: string) => void): Promise<AgentResult> {
    const { config, llmProvider, logger } = this.deps

    const orchestrator = new OrchestratorClient({ model: config.orchestrator.model, provider: config.orchestrator.provider }, llmProvider)

    if (!orchestrator.isEnabled()) {
      logger.debug('MoE enabled but no orchestrator model configured — falling back to single-agent')
      return this.executeSingleAgentLoop(input, _onChunk, onMeta)
    }

    onMeta?.('🤖 Planning with MoE mode...\n')
    const planResult = await orchestrator.plan(input)
    if ('error' in planResult) {
      logger.warn(`MoE plan failed: ${planResult.error} — falling back to single-agent`)
      return this.executeSingleAgentLoop(input, _onChunk, onMeta)
    }

    const { plan } = planResult
    onMeta?.(`📋 Plan created: "${plan.title}" (${plan.subtasks.length} subtasks)\n`)

    const validation = validatePlan(plan, config)
    if (!validation.valid) {
      const applied = applyAutoFixes(plan, validation.autoFixes)
      const retry = validatePlan(applied, config)
      if (!retry.valid) {
        logger.warn(`MoE plan validation failed: ${retry.errors.join('; ')} — falling back to single-agent`)
        onMeta?.(`⚠️ Plan validation failed. Falling back to single-agent mode.\n`)
        return this.executeSingleAgentLoop(input, _onChunk, onMeta)
      }
      Object.assign(plan, applied)
      onMeta?.(`🔧 Auto-fixed ${validation.autoFixes.length} plan issues.\n`)
    }

    const moeDeps = {
      config,
      toolRegistry: (this.deps.toolExecutor as any).registry,
      toolExecutor: this.deps.toolExecutor,
      llmProvider,
      logger,
      baseDir: this.deps.baseDir,
    }

    const executor = new MoEExecutor(moeDeps)
    onMeta?.(`⚙️ Executing ${plan.subtasks.length} subtasks...\n`)
    const planResults = await executor.executePlan(plan)
    onMeta?.(`✅ Execution complete: ${planResults.results.filter(r => r.success).length}/${planResults.results.length} succeeded\n`)

    const verifier = new StepVerifier(this.deps.baseDir)
    const knownTags = ['file', 'code', 'shell', 'research', 'browser', 'vision', 'core']
    const verification = await verifier.verifyMoEManifest(plan, config, knownTags)

    const verifyResult = await orchestrator.verifyAndMerge({
      plan,
      results: planResults.results.map(r => ({ subtaskId: r.subtaskId, success: r.success, summary: r.summary, result: r.result, error: r.error })),
      verifierErrors: verification.errors,
      verifierWarnings: verification.warnings,
    })

    const outputLines: string[] = [`## MoE Execution Results\n`]
    for (const r of planResults.results) {
      const icon = r.success ? '✅' : '❌'
      outputLines.push(`${icon} **${r.subtaskId}**: ${r.summary} (${r.durationMs}ms)`)
    }
    outputLines.push('')
    if (verifyResult.type === 'final') {
      outputLines.push(`**Result:** ${verifyResult.finalAnswer || 'Complete'}`)
    } else {
      outputLines.push(`**Re-plan requested:** ${verifyResult.explanation || ''}`)
    }

    const failedCount = planResults.results.filter(r => !r.success).length
    return {
      success: failedCount === 0 && verification.success,
      text: outputLines.join('\n'),
      iterationCount: planResults.results.length,
    }
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
