import { describe, it, expect } from 'vitest'
import { planTool } from '../../src/tools/plan'

describe('planTool', () => {
  it('has correct definition', () => {
    expect(planTool.name).toBe('plan')
    expect(planTool.description).toBeTruthy()
    expect(planTool.parameters.required).toContain('action')
  })
})
