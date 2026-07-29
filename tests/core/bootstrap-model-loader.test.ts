import { describe, expect, it, vi, beforeEach, afterEach } from 'bun:test'
import { bootstrap } from '../../src/core/bootstrap'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'

describe('Bootstrap model loader', () => {
  let originalFetch: typeof global.fetch

  beforeEach(() => {
    originalFetch = global.fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('should call ModelLoader.ensureModelLoaded when autoLoad is true', async () => {
    const configDir = '/tmp/test-config-model-auto'
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      version: '2.0.0',
      model: 'test',
      provider: { type: 'openai-compat', baseUrl: 'http://localhost:1234/v1', apiKey: 'test' },
      modelLoad: { autoLoad: true, flashAttention: true, offloadKvCacheToGpu: true },
      contextWindow: 32768,
      contextBudget: { systemPrompt: 0.25, responseReserve: 0.12, compactionThreshold: 0.75 },
      maxToolIterations: 25,
      stuckThreshold: 8,
      autoPlan: true,
      logLevel: 'info',
      locale: 'en',
      session: { autoSave: true, maxSessions: 50, isolateMemory: false },
    }))

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [] }),
    })
    global.fetch = mockFetch as any

    const result = await bootstrap(configDir, '/tmp/test-project')

    expect(mockFetch).toHaveBeenCalled()
    const calls = mockFetch.mock.calls
    const modelCheckCall = calls.find(c => c[0].toString().includes('/api/v1/models'))
    expect(modelCheckCall).toBeDefined()

    rmSync(configDir, { recursive: true, force: true })
  })

  it('should not call ModelLoader when autoLoad is false', async () => {
    const configDir = '/tmp/test-config-no-auto'
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      version: '2.0.0',
      model: 'test',
      provider: { type: 'openai-compat', baseUrl: 'http://localhost:1234/v1', apiKey: 'test' },
      modelLoad: { autoLoad: false, flashAttention: true, offloadKvCacheToGpu: true },
      contextWindow: 32768,
      contextBudget: { systemPrompt: 0.25, responseReserve: 0.12, compactionThreshold: 0.75 },
      maxToolIterations: 25,
      stuckThreshold: 8,
      autoPlan: true,
      logLevel: 'info',
      locale: 'en',
      session: { autoSave: true, maxSessions: 50, isolateMemory: false },
    }))

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [] }),
    })
    global.fetch = mockFetch as any

    const result = await bootstrap(configDir, '/tmp/test-project')

    const calls = mockFetch.mock.calls
    const modelLoadCall = calls.find(c => c[0].toString().includes('/api/v1/models/load'))
    expect(modelLoadCall).toBeUndefined()

    rmSync(configDir, { recursive: true, force: true })
  })
})
