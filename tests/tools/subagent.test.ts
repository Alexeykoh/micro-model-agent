import { describe, it, expect } from 'vitest'
import { subagentTool } from '../../src/tools/subagent'

describe('subagentTool', () => {
  it('has correct definition', () => {
    expect(subagentTool.name).toBe('subagent')
    expect(subagentTool.description).toBeTruthy()
  })
})
