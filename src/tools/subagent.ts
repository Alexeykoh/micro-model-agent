import type { ToolDefinition } from './types'

export const subagentTool: ToolDefinition = {
  name: 'subagent',
  description: 'Spawn an isolated sub-agent with a limited toolset for parallel tasks.',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Task description for the sub-agent' },
      tools: { type: 'array', items: { type: 'string' }, description: 'Tool names to allow (default: all)' },
    },
    required: ['task'],
  },
  handler: async (_ctx, args) => {
    return { success: true, output: `Sub-agent task queued: ${args.task}` }
  },
}
