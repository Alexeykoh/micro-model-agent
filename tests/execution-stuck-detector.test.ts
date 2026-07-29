import { describe, it, expect, beforeEach } from 'vitest'
import { StuckDetector } from '../src/modules/execution/stuck-detector'

describe('StuckDetector', () => {
  let detector: StuckDetector

  beforeEach(() => {
    detector = new StuckDetector(5, 3)
  })

  it('should not trigger initially', () => {
    expect(detector.isStuck()).toBe(false)
  })

  it('should trigger after threshold iterations without step change', () => {
    for (let i = 0; i < 6; i++) {
      detector.recordIteration(1)
    }
    expect(detector.isStuck()).toBe(true)
  })

  it('should reset on step change', () => {
    for (let i = 0; i < 4; i++) detector.recordIteration(1)
    detector.recordIteration(2)
    expect(detector.isStuck()).toBe(false)
  })

  it('should detect repetitive tool errors', () => {
    for (let i = 0; i < 4; i++) {
      detector.recordToolError('bash')
    }
    expect(detector.hasRepetitiveErrors('bash')).toBe(true)
  })

  it('should detect off-track tool usage', () => {
    detector.setCurrentStep(2, 'create src/routes/oauth.ts')
    const result = detector.checkOffTrack('edit', {
      name: 'edit_file',
      arguments: { path: 'src/utils/logger.ts' },
    })
    expect(result).toBeDefined()
    if (result) {
      expect(result).toContain('Outside plan')
    }
  })

  it('should allow on-track tool usage', () => {
    detector.setCurrentStep(2, 'create src/routes/oauth.ts')
    const result = detector.checkOffTrack('edit', {
      name: 'edit_file',
      arguments: { path: 'src/routes/oauth.ts' },
    })
    expect(result).toBeNull()
  })
})
