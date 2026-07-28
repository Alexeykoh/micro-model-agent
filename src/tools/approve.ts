import type { ToolDefinition } from './types'

export const approveTool: ToolDefinition = {
  name: 'approve',
  description: 'Request user approval before a potentially dangerous operation (mass delete, destructive commands).',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Action description' },
      details: { type: 'string', description: 'Details to show the user' },
    },
    required: ['action', 'details'],
  },
  handler: async (_ctx, args) => {
    return { success: true, output: `[Approval requested: ${args.action}]` }
  },
}
