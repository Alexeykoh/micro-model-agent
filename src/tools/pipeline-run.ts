import { t } from '../i18n/index'
import type { ToolDefinition } from './types'
import { PipelineEngine } from '../modules/pipelines/engine'
import { PipelineParser } from '../modules/pipelines/parser'

const engine = new PipelineEngine()

export const pipelineRunTool: ToolDefinition = {
  name: 'pipeline_run',
  description: 'Run a named pipeline with YAML definition. Creates a DAG of sub-agents that execute in dependency order.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Pipeline name' },
      yaml: { type: 'string', description: 'Pipeline YAML definition with steps' },
    },
    required: ['name', 'yaml'],
  },
  handler: async (_ctx, args) => {
    const name = String(args.name || '')
    const yaml = String(args.yaml || '')
    
    if (!yaml) {
      return { success: false, output: t('pipeline.invalid') }
    }

    try {
      const pipeline = PipelineParser.parse(yaml)
      const order = engine.resolveDependencies(pipeline.steps)
      const readySteps = engine.getReadySteps(pipeline.steps, new Set())
      
      const summary = [
        `Pipeline "${pipeline.name}" parsed successfully.`,
        `Steps: ${pipeline.steps.length}`,
        `Execution order: ${order.join(' → ')}`,
        `Ready to run: ${readySteps.map(s => s.id).join(', ') || '(none)'}`,
      ].join('\n')
      
      return { success: true, output: summary }
    } catch (e: any) {
      return { success: false, output: `Pipeline error: ${e.message}` }
    }
  },
}
