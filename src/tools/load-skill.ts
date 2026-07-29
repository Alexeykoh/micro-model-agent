import { t } from '../i18n/index'
import type { ToolDefinition } from './types'
import type { SkillsModule } from '../modules/skills/module'

export function createLoadSkillTool(skillsModule: SkillsModule): ToolDefinition {
  return {
    name: 'load_skill',
    description: 'Load a skill by name or task description. Skills provide specialized instructions and workflows. Use when you need domain-specific knowledge.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name to load directly' },
        task: { type: 'string', description: 'Task description to find matching skill' },
      },
    },
    handler: async (_ctx, args) => {
      const name = args.name ? String(args.name) : undefined
      const task = args.task ? String(args.task) : undefined

      if (!name && !task) {
        return { success: false, output: t('tool.name_or_task') }
      }

      let result
      if (name) {
        result = skillsModule.loadByName(name)
      } else if (task) {
        result = skillsModule.loadByMatch(task)
      } else {
        return { success: false, output: t('tool.invalid_params') }
      }

      if (!result.success) {
        return { success: false, output: result.message }
      }

      const skill = result.skill!
      const budget = skillsModule.getBudget()
      return {
        success: true,
        output: `${result.message}\n\n--- Skill Content ---\n${skill.content}\n\n${t('tool.skill_budget', { remaining: budget.remaining })}`,
      }
    },
  }
}
