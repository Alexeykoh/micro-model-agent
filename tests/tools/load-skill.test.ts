import { describe, it, expect } from 'vitest'
import { createLoadSkillTool } from '../../src/tools/load-skill'
import { SkillsModule } from '../../src/modules/skills/module'
import { SkillsMatcher } from '../../src/modules/skills/matcher'

describe('loadSkillTool', () => {
  it('has correct definition', () => {
    const matcher = new SkillsMatcher()
    const skillsModule = new SkillsModule([], matcher, 1000)
    const tool = createLoadSkillTool(skillsModule)
    expect(tool.name).toBe('load_skill')
    expect(tool.description).toBeTruthy()
    expect(tool.parameters.properties).toHaveProperty('name')
    expect(tool.parameters.properties).toHaveProperty('task')
  })
})
