import type { ToolDefinition } from './types'

export const loadSkillTool: ToolDefinition = {
  name: 'load_skill',
  description: 'Load a skill by describing the task. System matches the most relevant skill from available skill files.',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Task description to match against available skills' },
    },
    required: ['task'],
  },
  handler: async (_ctx, args) => {
    return { success: true, output: `[Skill load requested for: ${args.task}]` }
  },
}
