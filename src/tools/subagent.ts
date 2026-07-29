import { t } from '../i18n/index'
import type { ToolDefinition } from './types'

export const subagentTool: ToolDefinition = {
  name: 'subagent',
  description: 'Spawn a sub-agent to work on a task independently. The sub-agent receives a task description and works autonomously.',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Task description for the sub-agent' },
    },
    required: ['task'],
  },
  handler: async (_ctx, args) => {
    const task = String(args.task || '')
    return { success: true, output: t('tool.subagent_queued', { task }) }
  },
}
