import { describe, it, expect, vi } from 'vitest'
import { UpdaterModule } from '../src/modules/updater/module'
import type { UpdaterConfig } from '../src/config/types'

function makeConfig(overrides: Partial<UpdaterConfig> = {}): UpdaterConfig {
  return { enabled: true, checkOnStart: true, autoInstall: false, intervalMs: 0, ...overrides }
}

describe('UpdaterModule', () => {
  it('should not start when disabled', () => {
    const mod = new UpdaterModule(makeConfig({ enabled: false }), '0.3.0', 'micro-models-agent')
    mod.start()
    expect(mod.isStarted()).toBe(false)
  })

  it('should start a single check (intervalMs 0) and finish', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ 'dist-tags': { latest: '0.3.0' } }),
    })
    global.fetch = mockFetch as any

    const mod = new UpdaterModule(makeConfig(), '0.3.0', 'micro-models-agent')
    mod.setInstallEnabled(false)
    mod.start()
    expect(mod.isStarted()).toBe(true)

    await mod.runOnce()
    // Single-shot loop stops itself after the first check.
    await new Promise((r) => setTimeout(r, 30))
    expect(mod.isStarted()).toBe(false)
  })

  it('should notify when an update is available (no auto-install)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ 'dist-tags': { latest: '0.4.0' } }),
    })
    global.fetch = mockFetch as any

    const messages: string[] = []
    const mod = new UpdaterModule(makeConfig({ autoInstall: false }), '0.3.0', 'micro-models-agent', {
      info: (m) => messages.push(m),
      warn: (m) => messages.push(m),
      error: (m) => messages.push(m),
    })
    mod.setInstallEnabled(false)
    await mod.runOnce()
    expect(messages.some((m) => m.includes('0.4.0'))).toBe(true)
  })

  it('should auto-install when enabled', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ 'dist-tags': { latest: '0.4.0' } }),
    })
    global.fetch = mockFetch as any
    const runner = vi.fn().mockResolvedValue({})

    const messages: string[] = []
    const mod = new UpdaterModule(makeConfig({ autoInstall: true }), '0.3.0', 'micro-models-agent', {
      info: (m) => messages.push(m),
      warn: (m) => messages.push(m),
      error: (m) => messages.push(m),
    }, runner as any)
    await mod.runOnce()
    expect(runner).toHaveBeenCalled()
    expect(messages.some((m) => m.includes('0.4.0') && /Installed|Установлена/.test(m))).toBe(true)
  })

  it('should stop the loop', () => {
    const mod = new UpdaterModule(makeConfig({ intervalMs: 60000 }), '0.3.0', 'micro-models-agent')
    mod.start()
    expect(mod.isStarted()).toBe(true)
    mod.stop()
    expect(mod.isStarted()).toBe(false)
  })

  it('waitForIdle resolves after the single-shot check settles', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ 'dist-tags': { latest: '0.3.0' } }),
    })
    global.fetch = mockFetch as any

    const mod = new UpdaterModule(makeConfig(), '0.3.0', 'micro-models-agent')
    mod.setInstallEnabled(false)
    mod.start()
    await mod.waitForIdle(2000)
    expect(mod.isStarted()).toBe(false)
  })

  it('waitForIdle returns immediately when never started', async () => {
    const mod = new UpdaterModule(makeConfig(), '0.3.0', 'micro-models-agent')
    await mod.waitForIdle(500)
    expect(mod.isStarted()).toBe(false)
  })
})
