import type { ToolDefinition } from './types'

export const pipelineRunTool: ToolDefinition = {
  name: 'pipeline_run',
  description: 'Run a predefined task workflow pipeline. Pipelines are defined as YAML with DAG dependencies.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Pipeline name' },
      params: { type: 'object', description: 'Pipeline parameters (key-value pairs)' },
    },
    required: ['name'],
  },
  handler: async (_ctx, args) => {
    return { success: true, output: `[Pipeline run requested: ${args.name}]` }
  },
}
