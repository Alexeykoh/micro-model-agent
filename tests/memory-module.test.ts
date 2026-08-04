// tests/memory-module.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { MemoryStore } from '../src/modules/memory/store'
import { MemoryModule } from '../src/modules/memory/module'

describe('MemoryStore extensions', () => {
  let dir: string
  let store: MemoryStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memory-test-'))
    store = new MemoryStore(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('should include facts in MEMORY_FILES', () => {
    expect(existsSync(join(dir, 'facts.md'))).toBe(true)
  })

  it('should set and get preferences', () => {
    store.setPreference('color', 'green')
    expect(store.getPreferences()).toEqual({ color: 'green' })
  })

  it('should overwrite preference', () => {
    store.setPreference('color', 'green')
    store.setPreference('color', 'blue')
    expect(store.getPreferences()).toEqual({ color: 'blue' })
  })

  it('should delete preference', () => {
    store.setPreference('color', 'green')
    const deleted = store.deletePreference('color')
    expect(deleted).toBe(true)
    expect(store.getPreferences()).toEqual({})
  })

  it('should return false when deleting non-existent preference', () => {
    const deleted = store.deletePreference('nonexistent')
    expect(deleted).toBe(false)
  })

  it('should append to facts', () => {
    store.append('facts', 'User prefers dark theme')
    const content = store.read('facts')
    expect(content).toContain('User prefers dark theme')
  })

  it('should search preferences', () => {
    store.setPreference('color', 'green')
    const results = store.search('green')
    expect(results.some(r => r.file === 'preferences' && r.match.includes('color'))).toBe(true)
  })

  it('should search facts', () => {
    store.append('facts', 'User works on MMA project')
    const results = store.search('MMA')
    expect(results.some(r => r.file === 'facts')).toBe(true)
  })
})

describe('MemoryModule', () => {
  let dir: string
  let mod: MemoryModule

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memory-module-test-'))
    mod = new MemoryModule(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('should return null prompt block when no preferences', () => {
    expect(mod.getSystemPromptBlock()).toBeNull()
  })

  it('should return prompt block with preferences', () => {
    mod.getStore().setPreference('color', 'green')
    const block = mod.getSystemPromptBlock()
    expect(block).not.toBeNull()
    expect(block!.content).toContain('color=green')
  })

  it('should provide remember and recall tools', () => {
    const tools = mod.getToolDefinitions()
    expect(tools.map(t => t.name)).toContain('remember')
    expect(tools.map(t => t.name)).toContain('recall')
  })

  it('should have plugin with onBuildPrompt', () => {
    const plugin = mod.getPlugin()
    expect(plugin.name).toBe('memory')
    expect(plugin.onBuildPrompt).toBeDefined()
  })

  it('plugin onBuildPrompt returns null when no preferences', () => {
    const plugin = mod.getPlugin()
    expect(plugin.onBuildPrompt!()).toBeNull()
  })

  it('plugin onBuildPrompt returns preferences string', () => {
    mod.getStore().setPreference('lang', 'ru')
    const plugin = mod.getPlugin()
    expect(plugin.onBuildPrompt!()).toContain('lang=ru')
  })
})
