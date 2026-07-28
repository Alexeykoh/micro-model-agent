import type { ToolDefinition } from './types'

export const todoTool: ToolDefinition = {
  name: 'todo',
  description: 'Manage sub-tasks within a plan step. Add items to track sub-steps, mark them done.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'done', 'list'], description: 'Action' },
      step: { type: 'number', description: 'Plan step number' },
      items: { type: 'array', items: { type: 'string' }, description: 'Items to add' },
      id: { type: 'string', description: 'Item ID to mark done' },
    },
    required: ['action'],
  },
  handler: async (_ctx, args) => {
    return { success: true, output: `Todo ${args.action}: acknowledged` }
  },
}
