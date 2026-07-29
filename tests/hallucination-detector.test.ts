import { describe, it, expect } from 'vitest'
import { HallucinationDetector } from '../src/modules/hallucination/detector'

describe('HallucinationDetector', () => {
  it('should pass on normal response', () => {
    const detector = new HallucinationDetector()
    const result = detector.validate('This is a normal response about the codebase.')
    expect(result.status).toBe('pass')
  })

  it('should retry on empty', () => {
    const detector = new HallucinationDetector()
    const result = detector.validate('')
    expect(result.status).toBe('retry')
  })

  it('should warn on unknown paths', () => {
    const detector = new HallucinationDetector()
    const result = detector.validate('I modified src/unknown-file.ts')
    expect(result.status).toBe('warn')
  })

  it('should warn on uncertainty', () => {
    const detector = new HallucinationDetector()
    const result = detector.validate('I think maybe we should use this approach.')
    expect(result.status).toBe('warn')
  })

  it('should aggregate multiple warnings', () => {
    const detector = new HallucinationDetector()
    const result = detector.validate('I think maybe we changed src/mystery.ts')
    expect(result.status).toBe('warn')
  })
})
