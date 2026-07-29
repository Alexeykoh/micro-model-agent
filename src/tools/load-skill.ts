import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { ToolDefinition } from './types'

export const loadSkillTool: ToolDefinition = {
  name: 'load_skill',
  description: 'Load a skill from the skills directory. Skills provide specialized instructions and workflows.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name (filename without .md)' },
    },
    required: ['name'],
  },
  handler: async (_ctx, args) => {
    const name = String(args.name || '')
    const searchPaths = [
      join(homedir(), '.agents', 'skills', name, 'SKILL.md'),
      join(homedir(), '.mma', 'skills', `${name}.md`),
    ]
    for (const skillPath of searchPaths) {
      if (existsSync(skillPath)) {
        const content = readFileSync(skillPath, 'utf-8')
        const lines = content.split('\n').slice(0, 50).join('\n')
        return { success: true, output: `Skill "${name}" loaded.\n${lines}` }
      }
    }
    return { success: false, output: `Skill "${name}" not found in any search path` }
  },
}
