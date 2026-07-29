import { describe, it, expect } from 'vitest'
import { bootstrap } from '../../src/core/bootstrap'

describe('bootstrap', () => {
  it('creates agent with valid config', () => {
    const result = bootstrap('/nonexistent/mma-config', process.cwd())
    expect(result.agent).toBeDefined()
    expect(result.config).toBeDefined()
    expect(result.logger).toBeDefined()
  })

  it('uses defaults when no config found', () => {
    const result = bootstrap('/nonexistent/mma-config')
    expect(result.agent).toBeDefined()
    expect(result.config.model).toBe('qwen3.5-9b')
  })
})
