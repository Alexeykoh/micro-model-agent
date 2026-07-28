import type { ToolDefinition } from './types'

export const planTool: ToolDefinition = {
  name: 'plan',
  description: 'Create, update, or abort a multi-step plan. System calls create automatically for multi-step tasks.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'update', 'abort'], description: 'Action to perform' },
      title: { type: 'string', description: 'Plan title (for create)' },
      steps: { type: 'array', items: { type: 'string' }, description: 'Step descriptions (for create)' },
      step: { type: 'number', description: 'Step number (for update)' },
      status: { type: 'string', enum: ['done', 'failed', 'skipped'], description: 'Step status (for update)' },
      note: { type: 'string', description: 'Optional note (for update)' },
    },
    required: ['action'],
  },
  handler: async (_ctx, args) => {
    return { success: true, output: `Plan ${args.action}: acknowledged` }
  },
}
