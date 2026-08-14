import { describe, it, expect } from 'vitest'
import { DEFAULTS } from '../../src/config/defaults'
import { getExpertConfig, validateExpertConfig } from '../../src/config/experts'
import { validateConfig } from '../../src/config/config'
import type { AppConfig } from '../../src/config/types'

const KNOWN_TAGS = ['file', 'code', 'shell', 'research', 'browser', 'vision', 'core']

describe('experts defaults', () => {
  it('has experts in defaults', () => {
    expect(DEFAULTS.experts).toBeDefined()
    expect(Object.keys(DEFAULTS.experts).length).toBeGreaterThanOrEqual(4)
  })

  it('code expert has file, code, shell tags', () => {
    const code = DEFAULTS.experts.code
    expect(code).toBeDefined()
    expect(code.tool_tags).toContain('file')
    expect(code.tool_tags).toContain('code')
    expect(code.tool_tags).toContain('shell')
    expect(code.max_attempts).toBe(3)
  })

  it('research expert has research tag', () => {
    const research = DEFAULTS.experts.research
    expect(research).toBeDefined()
    expect(research.tool_tags).toContain('research')
  })

  it('browser expert has browser and vision tags', () => {
    const browser = DEFAULTS.experts.browser
    expect(browser).toBeDefined()
    expect(browser.tool_tags).toContain('browser')
    expect(browser.tool_tags).toContain('vision')
  })

  it('vision expert has browser, vision, file tags', () => {
    const vision = DEFAULTS.experts.vision
    expect(vision).toBeDefined()
    expect(vision.tool_tags).toContain('browser')
    expect(vision.tool_tags).toContain('vision')
    expect(vision.tool_tags).toContain('file')
  })
})

describe('getExpertConfig', () => {
  it('returns expert config for known tag', () => {
    const expert = getExpertConfig(DEFAULTS, 'code')
    expect(expert).toBeDefined()
    expect(expert!.model).toBe('qwen/qwen3.5-9b')
  })

  it('returns undefined for unknown tag', () => {
    const expert = getExpertConfig(DEFAULTS, 'nonexistent')
    expect(expert).toBeUndefined()
  })
})

describe('validateExpertConfig', () => {
  it('passes for valid defaults', () => {
    const errors = validateExpertConfig(DEFAULTS, KNOWN_TAGS)
    expect(errors).toHaveLength(0)
  })

  it('rejects unknown tool_tag', () => {
    const badConfig: AppConfig = {
      ...DEFAULTS,
      experts: {
        bad: { model: 'test', tool_tags: ['nonexistent_tag'] },
      },
    }
    const errors = validateExpertConfig(badConfig, KNOWN_TAGS)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]).toContain('nonexistent_tag')
  })

  it('rejects multiple unknown tags', () => {
    const badConfig: AppConfig = {
      ...DEFAULTS,
      experts: {
        bad: { model: 'test', tool_tags: ['unknown1', 'unknown2'] },
      },
    }
    const errors = validateExpertConfig(badConfig, KNOWN_TAGS)
    expect(errors.length).toBeGreaterThanOrEqual(2)
  })
})

describe('validateConfig', () => {
  it('throws on invalid expert config', () => {
    const badConfig: AppConfig = {
      ...DEFAULTS,
      experts: {
        bad: { model: 'test', tool_tags: ['nonexistent'] },
      },
    }
    expect(() => validateConfig(badConfig, KNOWN_TAGS)).toThrow('Config validation failed')
  })

  it('passes for valid config', () => {
    expect(() => validateConfig(DEFAULTS, KNOWN_TAGS)).not.toThrow()
  })
})
