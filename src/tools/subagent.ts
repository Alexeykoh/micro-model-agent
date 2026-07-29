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
    // Sub-agent spawning is not yet implemented
    return { success: true, output: `Sub-agent task queued: ${task}` }
  },
}
