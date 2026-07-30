import { describe, it, expect } from 'vitest'
import { questionTool } from '../../src/tools/question'

describe('questionTool', () => {
  it('has correct definition', () => {
    expect(questionTool.name).toBe('question')
    expect(questionTool.description).toBeTruthy()
    expect(questionTool.parameters.required).toContain('question')
  })
})
