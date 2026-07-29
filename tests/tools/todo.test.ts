import { describe, it, expect } from 'vitest'
import { todoTool } from '../../src/tools/todo'

describe('todoTool', () => {
  it('has correct definition', () => {
    expect(todoTool.name).toBe('todo')
    expect(todoTool.description).toBeTruthy()
    expect(todoTool.parameters.required).toContain('action')
  })
})
