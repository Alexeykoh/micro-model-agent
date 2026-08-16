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

  it('should deduplicate by name — higher version wins', () => {
    const pm = new PluginManager()
    pm.register({ name: 'dup', version: '1.0.0' })
    const res = pm.register({ name: 'dup', version: '2.0.0' })
    expect(res.status).toBe('registered')
    const plugins = pm.getAllPlugins()
    expect(plugins).toHaveLength(1)
    expect(plugins[0].version).toBe('2.0.0')
  })

  it('should keep the existing plugin when the incoming version is lower', () => {
    const pm = new PluginManager()
    pm.register({ name: 'dup', version: '2.0.0' })
    const res = pm.register({ name: 'dup', version: '1.0.0' })
    expect(res.status).toBe('skipped_older')
    const plugins = pm.getAllPlugins()
    expect(plugins).toHaveLength(1)
    expect(plugins[0].version).toBe('2.0.0')
  })

  it('should deduplicate unversioned plugins as 0.0.0', () => {
    const pm = new PluginManager()
    pm.register({ name: 'dup', version: '1.0.0' })
    pm.register({ name: 'dup' })
    const plugins = pm.getAllPlugins()
    expect(plugins).toHaveLength(1)
    expect(plugins[0].version).toBe('1.0.0')
  })

  it('should return duplicate status for identical name+version', () => {
    const pm = new PluginManager()
    pm.register({ name: 'dup', version: '1.0.0' })
    const res = pm.register({ name: 'dup', version: '1.0.0' })
    expect(res.status).toBe('skipped_older')
    expect(pm.getAllPlugins()).toHaveLength(1)
  })

  it('should record source and expose it via getPluginInfos', () => {
    const pm = new PluginManager()
    pm.register({ name: 'global-p', version: '1.0.0' }, 'global')
    pm.register({ name: 'project-p' }, 'project')
    pm.register({ name: 'builtin-p' }, 'builtin')
    const infos = pm.getPluginInfos()
    expect(infos).toHaveLength(3)
    const byName = Object.fromEntries(infos.map((i) => [i.plugin.name, i.source]))
    expect(byName['global-p']).toBe('global')
    expect(byName['project-p']).toBe('project')
    expect(byName['builtin-p']).toBe('builtin')
  })

  it('should look up a plugin by name via getPlugin', () => {
    const pm = new PluginManager()
    pm.register({ name: 'target', version: '3.0.0' })
    expect(pm.getPlugin('target')?.version).toBe('3.0.0')
    expect(pm.getPlugin('missing')).toBeNull()
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

  it('should pass the response to runOnAfterThink', () => {
    const pm = new PluginManager()
    const hook = vi.fn()
    pm.register({ name: 'thinker', onAfterThink: hook })

    pm.runOnAfterThink({} as any, { type: 'text', content: 'hi' })
    expect(hook).toHaveBeenCalledWith({} as any, { type: 'text', content: 'hi' })
  })

  it('should dispatch onPhase', () => {
    const pm = new PluginManager()
    const hook = vi.fn()
    pm.register({ name: 'phase', onPhase: hook })

    pm.runOnPhase({} as any, 'thinking')
    expect(hook).toHaveBeenCalledWith({} as any, 'thinking')
  })

  it('should dispatch onToolStart and onToolEnd', () => {
    const pm = new PluginManager()
    const start = vi.fn()
    const end = vi.fn()
    pm.register({ name: 'tools', onToolStart: start, onToolEnd: end })

    const call = { id: '1', name: 'bash', arguments: {} }
    const result = { success: true, output: 'ok' }
    pm.runOnToolStart({} as any, call as any)
    pm.runOnToolEnd({} as any, call as any, result as any, 42)

    expect(start).toHaveBeenCalledWith({} as any, call)
    expect(end).toHaveBeenCalledWith({} as any, call, result, 42)
  })

  it('should pipe onText transforms in priority order', () => {
    const pm = new PluginManager()
    pm.register({
      name: 'first',
      priority: 10,
      onText: (_ctx: any, chunk: string) => chunk.replace(/a/g, 'b'),
    })
    pm.register({
      name: 'second',
      priority: 1,
      onText: (_ctx: any, chunk: string) => chunk.toUpperCase(),
    })

    expect(pm.runOnText({} as any, 'alpha')).toBe('BLPHB')
  })

  it('should passthrough onText when plugin returns undefined', () => {
    const pm = new PluginManager()
    pm.register({ name: 'pass', onText: () => undefined })
    expect(pm.runOnText({} as any, 'keep')).toBe('keep')
  })

  it('should pipe onMeta transforms and isolate errors', () => {
    const pm = new PluginManager()
    pm.register({
      name: 'crasher',
      onMeta: () => { throw new Error('boom') },
    })
    pm.register({
      name: 'redact',
      onMeta: (_ctx: any, chunk: string) => chunk.replace(/secret/g, 'red'),
    })

    expect(pm.runOnMeta({} as any, 'a secret')).toBe('a red')
  })
})
