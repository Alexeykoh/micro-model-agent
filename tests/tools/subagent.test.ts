import { describe, it, expect } from 'vitest'
import { subagentTool } from '../../src/tools/subagent'

describe('subagentTool', () => {
  it('has correct definition', () => {
    expect(subagentTool.name).toBe('subagent')
    expect(subagentTool.description).toBeTruthy()
    expect(subagentTool.parameters.required).toContain('task')
    const props = subagentTool.parameters.properties as Record<string, any>
    expect(props.task).toBeDefined()
    expect(props.context).toBeDefined()
  })

  it('fails when task is empty', async () => {
    const result = await subagentTool.handler({
      config: {
        contextWindow: 32768,
        contextBudget: { systemPrompt: 0.25, responseReserve: 0.12, compactionThreshold: 0.75 },
      },
      baseDir: '/tmp',
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    } as any, {
      task: '',
    })
    
    expect(result.success).toBe(false)
    expect(result.output).toContain('task')
  })

  it('has context parameter for additional constraints', () => {
    const props = subagentTool.parameters.properties as Record<string, any>
    expect(props.context.type).toBe('string')
    expect(props.context.description).toContain('context')
  })
})
