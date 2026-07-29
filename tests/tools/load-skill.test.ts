import { describe, it, expect } from 'vitest'
import { loadSkillTool } from '../../src/tools/load-skill'

describe('loadSkillTool', () => {
  it('has correct definition', () => {
    expect(loadSkillTool.name).toBe('load_skill')
    expect(loadSkillTool.description).toBeTruthy()
    expect(loadSkillTool.parameters.required).toContain('name')
  })
})
