import { describe, it, expect } from 'vitest'
import { ConsistencyCheck } from '../src/modules/hallucination/consistency'

describe('ConsistencyCheck', () => {
  it('should pass initially', () => {
    const check = new ConsistencyCheck()
    const result = check.validate('some text')
    expect(result.status).toBe('pass')
  })

  it('should warn on decision reversal', () => {
    const check = new ConsistencyCheck()
    check.trackDecision('use express', 'src/index.ts')
    const result = check.validate('I decided to use fastify instead of express')
    expect(result.status).toBe('warn')
  })

  it('should track created files', () => {
    const check = new ConsistencyCheck()
    check.trackCreatedFile('a.ts')
    expect(check.getCreatedFiles()).toContain('a.ts')
  })
})
