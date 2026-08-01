import { describe, it, expect } from 'vitest'
import { subagentTool } from '../src/tools/subagent'
import { ToolRegistry, ToolExecutor } from '../src/tools/index'
import { registerAllTools } from '../src/tools/index'

function makeCtx(overrides: Record<string, unknown> = {}) {
  const registry = new ToolRegistry()
  registerAllTools(registry)
  const executor = new ToolExecutor(registry, {
    logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
  } as any)
  return {
    baseDir: process.cwd(),
    config: {},
    logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    llmProvider: { chat: async () => {}, countTokens: () => 1 },
    toolExecutor: executor,
    sessionId: undefined,
    sessionContext: undefined,
    recursionDepth: 0,
    ...overrides,
  }
}

describe('subagent tool defensive guard', () => {
  it('should reject tool_tags that match no registered tools', async () => {
    const ctx = makeCtx()
    const result = await subagentTool.handler(ctx, {
      task: 'create a file',
      tool_tags: ['file-write'],
    })
    expect(result.success).toBe(false)
    expect(String(result.output)).toContain('SECURITY BLOCKED')
    expect(String(result.output)).toContain('file-write')
  })

  it('should pass through tool_tags that match registered tools (not blocked by guard)', async () => {
    const ctx = makeCtx()
    const result = await subagentTool.handler(ctx, {
      task: 'create a file',
      tool_tags: ['file'],
    })
    expect(String(result.output)).not.toContain('SECURITY BLOCKED')
    expect(String(result.output)).not.toContain('No tools match')
  })
})
