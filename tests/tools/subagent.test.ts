import { describe, it, expect, vi } from 'vitest'
import { subagentTool } from '../../src/tools/subagent'

const mockAgentRun = vi.fn().mockResolvedValue({ success: true, text: 'done', iterationCount: 1 })
const mockAgent = vi.fn().mockReturnValue({ run: mockAgentRun })

vi.mock('../../src/core/agent', () => ({
  Agent: mockAgent,
}))

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

  it('has scope and tool_tags parameters', () => {
    const props = subagentTool.parameters.properties as Record<string, any>
    expect(props.allowed_files).toBeDefined()
    expect(props.read_only_files).toBeDefined()
    expect(props.tool_tags).toBeDefined()
    expect(props.expert_tag).toBeDefined()
  })

  it('fails when llmProvider or toolExecutor is missing', async () => {
    const result = await subagentTool.handler({
      config: {
        contextWindow: 32768,
        contextBudget: { systemPrompt: 0.25, responseReserve: 0.12, compactionThreshold: 0.75 },
      },
      baseDir: '/tmp',
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    } as any, {
      task: 'do something',
    })

    expect(result.success).toBe(false)
    expect(result.output).toContain('missing llmProvider or toolExecutor')
  })

  it('passes scope and toolTags to Agent deps', async () => {
    mockAgent.mockClear()
    mockAgentRun.mockResolvedValue({ success: true, text: 'done', iterationCount: 1 })

    const result = await subagentTool.handler({
      config: {
        contextWindow: 32768,
        contextBudget: { systemPrompt: 0.25, responseReserve: 0.12, compactionThreshold: 0.75 },
      },
      baseDir: '/tmp',
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      llmProvider: {} as any,
      toolExecutor: { execute: () => ({}) } as any,
    } as any, {
      task: 'do something',
      allowed_files: ['src/file.ts'],
      read_only_files: ['docs/readme.md'],
      tool_tags: ['file', 'code'],
    })

    expect(result.success).toBe(true)
    const deps = mockAgent.mock.calls[0][0]
    expect(deps.scope).toEqual({ allowed_files: ['src/file.ts'], read_only_files: ['docs/readme.md'] })
    expect(deps.toolTags).toEqual(['file', 'code'])
  })
})
