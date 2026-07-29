import { describe, it, expect } from 'vitest'
import { FactualCheck } from '../src/modules/hallucination/factual'

describe('FactualCheck', () => {
  it('should pass when no paths mentioned', () => {
    const check = new FactualCheck()
    const result = check.validate('This is a response about the architecture')
    expect(result.status).toBe('pass')
  })

  it('should pass when mentioned path was read', () => {
    const check = new FactualCheck()
    check.trackReadPath('src/index.ts')
    const result = check.validate('I updated src/index.ts')
    expect(result.status).toBe('pass')
  })

  it('should warn when unknown path mentioned', () => {
    const check = new FactualCheck()
    const result = check.validate('I created src/new-file.ts')
    expect(result.status).toBe('warn')
    expect(result.reason).toContain('src/new-file.ts')
  })

  it('should track multiple paths', () => {
    const check = new FactualCheck()
    check.trackReadPath('a.ts')
    check.trackReadPath('b.ts')
    const result = check.validate('Check a.ts and b.ts')
    expect(result.status).toBe('pass')
  })
})
