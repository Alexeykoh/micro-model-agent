import { describe, it, expect } from 'vitest'
import { DEFAULTS } from '../src/config/defaults'

describe('config defaults', () => {
  it('should have version field', () => {
    expect(DEFAULTS.version).toBe('2.0.0')
  })

  it('should have all required fields', () => {
    expect(DEFAULTS.model).toBe('qwen3.5-9b')
    expect(DEFAULTS.provider.type).toBe('openai-compat')
    expect(DEFAULTS.provider.baseUrl).toBe('http://localhost:1234/v1')
    expect(DEFAULTS.provider.apiKey).toBe('not-needed')
    expect(DEFAULTS.contextWindow).toBe(32768)
    expect(DEFAULTS.maxToolIterations).toBe(25)
    expect(DEFAULTS.stuckThreshold).toBe(8)
    expect(DEFAULTS.autoPlan).toBe(true)
    expect(DEFAULTS.logLevel).toBe('info')
    expect(DEFAULTS.locale).toBe('en')
  })

  it('should have context budget defaults', () => {
    expect(DEFAULTS.contextBudget.systemPrompt).toBe(0.25)
    expect(DEFAULTS.contextBudget.responseReserve).toBe(0.12)
    expect(DEFAULTS.contextBudget.compactionThreshold).toBe(0.75)
  })

  it('should have orchestrator undefined by default', () => {
    expect(DEFAULTS.orchestrator.model).toBeUndefined()
    expect(DEFAULTS.orchestrator.provider).toBeUndefined()
  })
})
