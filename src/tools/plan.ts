import type { ToolDefinition } from './types'

export const planTool: ToolDefinition = {
  name: 'plan',
  description: 'Create, update, or abort a multi-step execution plan. Use "create" to start a plan, "update" to mark steps done, "abort" to cancel.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'update', 'abort'] },
      title: { type: 'string' },
      steps: { type: 'array', items: { type: 'string' } },
      step: { type: 'number' },
      status: { type: 'string', enum: ['done', 'failed', 'skipped'] },
    },
    required: ['action'],
  },
  handler: async (_ctx, args) => {
    const action = String(args.action || '')
    if (action === 'create') {
      const title = String(args.title || 'Plan')
      const steps = Array.isArray(args.steps) ? args.steps : []
      return { success: true, output: `Plan "${title}" created with ${steps.length} steps` }
    }
    if (action === 'update') {
      const step = Number(args.step || 0)
      const status = String(args.status || 'done')
      return { success: true, output: `Step ${step} marked as ${status}` }
    }
    if (action === 'abort') {
      return { success: true, output: 'Plan aborted' }
    }
    return { success: false, output: `Unknown plan action: ${action}` }
  },
}
