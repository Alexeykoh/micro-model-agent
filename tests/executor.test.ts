import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ToolExecutor } from '../src/tools/executor'
import { ToolRegistry } from '../src/tools/registry'
import type { ToolContext } from '../src/tools/types'

describe('ToolExecutor', () => {
  let registry: ToolRegistry
  let executor: ToolExecutor
  let ctx: ToolContext

  beforeEach(() => {
    registry = new ToolRegistry()
    ctx = {
      config: {} as any,
      baseDir: '/tmp',
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as any,
    }
    executor = new ToolExecutor(registry, ctx, { getAllPlugins: () => [] })
  })

  it('should execute a registered tool', async () => {
    registry.register({
      name: 'hello',
      description: 'says hello',
      parameters: { type: 'object', properties: { name: { type: 'string' } } },
      handler: async (_ctx, args) => ({
        success: true,
        output: `Hello ${args.name}`,
      }),
    })

    const result = await executor.execute({
      id: 'call_1',
      name: 'hello',
      arguments: { name: 'world' },
    })
    expect(result.success).toBe(true)
    expect(result.output).toBe('Hello world')
  })

  it('should throw for unknown tool', async () => {
    const result = await executor.execute({
      id: 'call_1',
      name: 'nonexistent',
      arguments: {},
    })
    expect(result.success).toBe(false)
    expect(result.output).toContain('Unknown tool')
  })

  it('should run plugin onBeforeTool hook', async () => {
    registry.register({
      name: 'blockable',
      description: '',
      parameters: { type: 'object', properties: {} },
      handler: async () => ({ success: true, output: 'ok' }),
    })

    const onBefore = vi.fn().mockReturnValue(false)
    executor = new ToolExecutor(registry, ctx, {
      getAllPlugins: () => [{ onBeforeTool: onBefore }],
    })

    const result = await executor.execute({
      id: 'call_1',
      name: 'blockable',
      arguments: {},
    })
    expect(onBefore).toHaveBeenCalled()
    expect(result.success).toBe(false)
  })

  it('should run plugin onAfterTool hook', async () => {
    registry.register({
      name: 'tracked',
      description: '',
      parameters: { type: 'object', properties: {} },
      handler: async () => ({ success: true, output: 'done' }),
    })

    const onAfter = vi.fn()
    executor = new ToolExecutor(registry, ctx, {
      getAllPlugins: () => [{ onAfterTool: onAfter }],
    })

    await executor.execute({ id: 'call_1', name: 'tracked', arguments: {} })
    expect(onAfter).toHaveBeenCalled()
  })

  it('should handle handler errors gracefully', async () => {
    registry.register({
      name: 'crash',
      description: '',
      parameters: { type: 'object', properties: {} },
      handler: async () => { throw new Error('boom') },
    })

    const result = await executor.execute({
      id: 'call_1',
      name: 'crash',
      arguments: {},
    })
    expect(result.success).toBe(false)
    expect(result.output).toContain('boom')
  })
})
