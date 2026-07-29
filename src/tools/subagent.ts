import { t } from '../i18n/index'
import type { ToolDefinition, ToolContext } from './types'
import { Agent } from '../core/agent'
import { ContextManager } from '../modules/context/manager'
import { HallucinationDetector } from '../modules/hallucination/detector'
import { PluginManager } from '../modules/plugins/manager'
import { PromptBuilder } from '../core/prompt-builder'
import type { PromptBlock } from '../core/types'

export const subagentTool: ToolDefinition = {
  name: 'subagent',
  description: 'Spawn an isolated sub-agent to work on a task independently. The sub-agent has its own context and executes autonomously. Use for parallel work or complex sub-tasks.',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Task description for the sub-agent' },
      context: { type: 'string', description: 'Optional context or constraints' },
    },
    required: ['task'],
  },
  handler: async (ctx: ToolContext, args) => {
    const task = String(args.task || '')
    const context = String(args.context || '')
    
    if (!task) {
      return { success: false, output: t('tool.name_or_task') }
    }

    try {
      const subContextManager = new ContextManager(ctx.config.contextWindow, ctx.config.contextBudget)
      const subPluginManager = new PluginManager()
      const hallucinationDetector = new HallucinationDetector()
      
      const systemBudget = Math.floor(ctx.config.contextWindow * ctx.config.contextBudget.systemPrompt)
      const builder = new PromptBuilder(systemBudget)
      const systemPrompt: PromptBlock = {
        content: `You are a sub-agent working on a specific task. ${context ? `Context: ${context}` : ''}`,
        priority: 'critical',
        essential: true,
        estimatedTokens: 100,
      }
      builder.addBlock(systemPrompt)
      const { prompt } = builder.build()
      subContextManager.addMessage({ role: 'system', content: prompt })
      
      const subDeps = {
        config: ctx.config,
        llmProvider: (ctx as any).llmProvider,
        toolExecutor: (ctx as any).toolExecutor,
        pluginManager: subPluginManager,
        contextManager: subContextManager,
        hallucinationDetector,
        logger: ctx.logger,
        baseDir: ctx.baseDir,
        promptBlocks: [systemPrompt],
      }
      
      const subAgent = new Agent(subDeps)
      const fullTask = context ? `${task}\n\nContext: ${context}` : task
      const result = await subAgent.run(fullTask)
      
      if (result.success) {
        return { 
          success: true, 
          output: `Sub-agent completed:\n${result.text}\n\nIterations: ${result.iterationCount}` 
        }
      } else {
        return { 
          success: false, 
          output: `Sub-agent failed: ${result.error}\nPartial output: ${result.text}` 
        }
      }
    } catch (e: any) {
      return { success: false, output: `Sub-agent error: ${e.message}` }
    }
  },
}
