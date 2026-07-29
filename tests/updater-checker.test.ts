import { describe, it, expect, vi } from 'vitest'
import { Updater } from '../src/modules/updater/checker'

describe('Updater', () => {
  it('should report current version', () => {
    const updater = new Updater('0.3.0', 'micro-models-agent')
    expect(updater.getCurrentVersion()).toBe('0.3.0')
  })

  it('should check npm registry', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ 'dist-tags': { latest: '0.4.0' } }),
    })
    global.fetch = mockFetch as any

    const updater = new Updater('0.3.0', 'micro-models-agent')
    const result = await updater.check()
    expect(result.updateAvailable).toBe(true)
    expect(result.latest).toBe('0.4.0')
  })

  it('should report no update when up to date', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ 'dist-tags': { latest: '0.3.0' } }),
    })
    global.fetch = mockFetch as any

    const updater = new Updater('0.3.0', 'micro-models-agent')
    const result = await updater.check()
    expect(result.updateAvailable).toBe(false)
  })

  it('should handle network errors gracefully', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('network error'))
    global.fetch = mockFetch as any

    const updater = new Updater('0.3.0', 'micro-models-agent')
    const result = await updater.check()
    expect(result.updateAvailable).toBe(false)
    expect(result.error).toBeDefined()
  })
})
