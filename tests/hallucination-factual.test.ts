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
    expect(result.reason).toContain('file paths not found')
  })

  it('should track multiple paths', () => {
    const check = new FactualCheck()
    check.trackReadPath('a.ts')
    check.trackReadPath('b.ts')
    const result = check.validate('Check a.ts and b.ts')
    expect(result.status).toBe('pass')
  })

  it('should pass for version numbers like 1.21.1', () => {
    const check = new FactualCheck()
    const result = check.validate('Minecraft version 1.21.1 is supported')
    expect(result.status).toBe('pass')
  })

  it('should pass for semantic versions like 2.0.0', () => {
    const check = new FactualCheck()
    const result = check.validate('Version 2.0.0 released with new features')
    expect(result.status).toBe('pass')
  })

  it('should pass for URLs', () => {
    const check = new FactualCheck()
    const result = check.validate('Visit https://example.com/page.html for details')
    expect(result.status).toBe('pass')
  })

  it('should pass for unknown file extensions', () => {
    const check = new FactualCheck()
    const result = check.validate('The model is qwen3.5-9b with 32k context')
    expect(result.status).toBe('pass')
  })

  it('should warn for unknown .ts paths', () => {
    const check = new FactualCheck()
    const result = check.validate('Check src/unknown.ts and lib/missing.js')
    expect(result.status).toBe('warn')
    expect(result.reason).toContain('src/unknown.ts')
    expect(result.reason).toContain('lib/missing.js')
  })
})
