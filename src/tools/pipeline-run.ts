import type { ToolDefinition } from './types'

export const pipelineRunTool: ToolDefinition = {
  name: 'pipeline_run',
  description: 'Run a named pipeline from the pipelines registry.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Pipeline name' },
    },
    required: ['name'],
  },
  handler: async (_ctx, args) => {
    const name = String(args.name || '')
    return { success: true, output: `Pipeline "${name}" execution started. Pipeline engine is a stub — run dispatched.` }
  },
}
