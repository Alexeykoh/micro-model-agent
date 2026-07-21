import { describe, it, expect, vi } from 'vitest';
import { PluginManager } from '../src/plugins/manager.js';
import type { AgentPlugin, PluginContext } from '../src/plugins/types.js';
import { PluginError } from '../src/plugins/types.js';

function createMockPlugin(name: string, opts?: { events?: string[] }): AgentPlugin {
  return {
    name,
    version: '1.0.0',
    onActivate: vi.fn(),
    onDeactivate: vi.fn(),
  };
}

function createMockContext(): PluginContext {
  return {
    cwd: '/tmp',
    config: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

describe('PluginManager', () => {
  it('register and list plugins', () => {
    const pm = new PluginManager();
    const p1 = createMockPlugin('test-a');
    const p2 = createMockPlugin('test-b');
    pm.register(p1);
    pm.register(p2);
    expect(pm.has('test-a')).toBe(true);
    expect(pm.has('test-b')).toBe(true);
    expect(pm.listPlugins()).toHaveLength(2);
  });

  it('activate and deactivate', async () => {
    const pm = new PluginManager();
    const p = createMockPlugin('my-plugin');
    pm.register(p);
    const ctx = createMockContext();
    await pm.activate('my-plugin', ctx);
    expect(pm.isActive('my-plugin')).toBe(true);
    expect(p.onActivate).toHaveBeenCalledWith(ctx);
    await pm.deactivate('my-plugin');
    expect(pm.isActive('my-plugin')).toBe(false);
    expect(p.onDeactivate).toHaveBeenCalled();
  });

  it('emit calls registered handlers', async () => {
    const pm = new PluginManager();
    const handler = vi.fn().mockReturnValue('result');
    const p: AgentPlugin = {
      name: 'handler-plugin',
      onActivate: vi.fn(),
    };
    pm.register(p);
    await pm.activate('handler-plugin', createMockContext());
    pm.on('tool:before', 'handler-plugin', handler);
    const result = await pm.emit('tool:before', 'write_file', { path: 'a.ts' });
    expect(handler).toHaveBeenCalledWith('write_file', { path: 'a.ts' }, undefined);
    expect(result).toBe('result');
  });

  it('emit skips inactive plugins', async () => {
    const pm = new PluginManager();
    const handler = vi.fn();
    const p: AgentPlugin = { name: 'inactive', onActivate: vi.fn() };
    pm.register(p);
    // NOT activated
    pm.on('tool:before', 'inactive', handler);
    await pm.emit('tool:before', 'test');
    expect(handler).not.toHaveBeenCalled();
  });

  it('PluginError blocks execution', async () => {
    const pm = new PluginManager();
    const p: AgentPlugin = { name: 'blocker', onActivate: vi.fn() };
    pm.register(p);
    await pm.activate('blocker', createMockContext());
    pm.on('tool:before', 'blocker', () => { throw new PluginError('blocked!'); });
    await expect(pm.emit('tool:before', 'test')).rejects.toThrow('blocked!');
  });

  it('error in one plugin does not break others', async () => {
    const pm = new PluginManager();
    const handler2 = vi.fn().mockReturnValue('ok');
    const p1: AgentPlugin = { name: 'broken', onActivate: vi.fn() };
    const p2: AgentPlugin = { name: 'healthy', onActivate: vi.fn() };
    pm.register(p1);
    pm.register(p2);
    await pm.activate('broken', createMockContext());
    await pm.activate('healthy', createMockContext());
    pm.on('tool:before', 'broken', () => { throw new Error('crash'); });
    pm.on('tool:before', 'healthy', handler2);
    const result = await pm.emit('tool:before', 'test');
    expect(handler2).toHaveBeenCalled();
    expect(result).toBe('ok');
  });

  it('emitModify chains modifications', async () => {
    const pm = new PluginManager();
    const p1: AgentPlugin = { name: 'p1', onActivate: vi.fn() };
    const p2: AgentPlugin = { name: 'p2', onActivate: vi.fn() };
    pm.register(p1);
    pm.register(p2);
    await pm.activate('p1', createMockContext());
    await pm.activate('p2', createMockContext());
    pm.on('llm:before', 'p1', (msgs: string[]) => [...msgs, 'added-by-p1']);
    pm.on('llm:before', 'p2', (msgs: string[]) => [...msgs, 'added-by-p2']);
    const result = await pm.emitModify<string[]>('llm:before', ['original']);
    expect(result).toEqual(['original', 'added-by-p1', 'added-by-p2']);
  });

  it('getPromptSections aggregates from active plugins', async () => {
    const pm = new PluginManager();
    const p1: AgentPlugin = {
      name: 'prompt-plugin',
      onActivate: vi.fn(),
      getPromptSection: async () => '## Plugin Section\nCustom instructions',
    };
    pm.register(p1);
    await pm.activate('prompt-plugin', createMockContext());
    const sections = await pm.getPromptSections();
    expect(sections).toEqual(['## Plugin Section\nCustom instructions']);
  });

  it('getPromptSections skips inactive plugins', async () => {
    const pm = new PluginManager();
    const p1: AgentPlugin = {
      name: 'inactive-prompt',
      onActivate: vi.fn(),
      getPromptSection: async () => 'should not appear',
    };
    pm.register(p1);
    // NOT activated
    const sections = await pm.getPromptSections();
    expect(sections).toEqual([]);
  });

  it('getBehaviors aggregates from active plugins', async () => {
    const pm = new PluginManager();
    const p1: AgentPlugin = {
      name: 'behavior-plugin',
      onActivate: vi.fn(),
      getBehaviors: () => ({ myBehavior: true, priority: 10 }),
    };
    pm.register(p1);
    await pm.activate('behavior-plugin', createMockContext());
    const behaviors = await pm.getBehaviors();
    expect(behaviors).toEqual({ myBehavior: true, priority: 10 });
  });

  it('register with source', () => {
    const pm = new PluginManager();
    const p = createMockPlugin('src-plugin');
    pm.register(p, 'builtin');
    const list = pm.listPlugins();
    expect(list).toHaveLength(1);
    expect(list[0].source).toBe('builtin');
  });

  it('listPlugins includes source', () => {
    const pm = new PluginManager();
    const p1 = createMockPlugin('a');
    const p2 = createMockPlugin('b');
    pm.register(p1, 'builtin');
    pm.register(p2, 'user');
    const list = pm.listPlugins();
    const srcA = list.find(p => p.name === 'a');
    const srcB = list.find(p => p.name === 'b');
    expect(srcA?.source).toBe('builtin');
    expect(srcB?.source).toBe('user');
  });

  it('getActivePluginNames', async () => {
    const pm = new PluginManager();
    const p1 = createMockPlugin('act-1');
    const p2 = createMockPlugin('act-2');
    pm.register(p1);
    pm.register(p2);
    const ctx = createMockContext();
    await pm.activate('act-1', ctx);
    await pm.activate('act-2', ctx);
    expect(pm.getActivePluginNames()).toEqual(['act-1', 'act-2']);
  });

  it('getActivePluginNames excludes inactive', async () => {
    const pm = new PluginManager();
    const p1 = createMockPlugin('ia-1');
    const p2 = createMockPlugin('ia-2');
    pm.register(p1);
    pm.register(p2);
    await pm.activate('ia-1', createMockContext());
    // ia-2 NOT activated
    expect(pm.getActivePluginNames()).toEqual(['ia-1']);
  });
});
