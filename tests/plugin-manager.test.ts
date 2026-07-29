import { describe, it, expect, vi } from 'vitest'
import { PluginManager } from '../src/modules/plugins/manager'
import type { AgentPlugin } from '../src/modules/types'

describe('PluginManager', () => {
  it('should register and list plugins', () => {
    const pm = new PluginManager()
    const plugin: AgentPlugin = { name: 'test' }
    pm.register(plugin)
    expect(pm.getAllPlugins()).toHaveLength(1)
  })

  it('should run onBeforeTool hooks and short-circuit on false', async () => {
    const pm = new PluginManager()
    pm.register({
      name: 'blocker',
      onBeforeTool: () => false,
    })
    pm.register({
      name: 'never-reached',
      onBeforeTool: () => true,
    })

    const result = await pm.runOnBeforeTool({} as any, {} as any)
    expect(result).toBe(false)
  })

  it('should continue on plugin error', async () => {
    const pm = new PluginManager()
    const goodPlugin = vi.fn().mockReturnValue(true)
    pm.register({
      name: 'crasher',
      onBeforeTool: () => { throw new Error('boom') },
    })
    pm.register({
      name: 'good',
      onBeforeTool: goodPlugin,
    })

    const result = await pm.runOnBeforeTool({} as any, {} as any)
    expect(result).toBe(true)
    expect(goodPlugin).toHaveBeenCalled()
  })

  it('should run onAfterTool hooks', async () => {
    const pm = new PluginManager()
    const hook = vi.fn()
    pm.register({ name: 'logger', onAfterTool: hook })

    await pm.runOnAfterTool({} as any, {} as any)
    expect(hook).toHaveBeenCalled()
  })

  it('should sort by priority', () => {
    const pm = new PluginManager()
    const order: string[] = []
    pm.register({ name: 'low', priority: 1, onBuildPrompt: () => { order.push('low'); return null } })
    pm.register({ name: 'high', priority: 10, onBuildPrompt: () => { order.push('high'); return null } })

    pm.runOnBuildPrompt()
    expect(order).toEqual(['high', 'low'])
  })
})
