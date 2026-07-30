import { describe, it, expect } from 'vitest'
import { TemplateEngine } from '../src/modules/pipelines/template'

describe('TemplateEngine', () => {
  it('should replace simple variables', () => {
    const result = TemplateEngine.render('Hello {name}', { name: 'world' })
    expect(result).toBe('Hello world')
  })

  it('should resolve step references', () => {
    const stepOutputs = { research: { output: 'Use TypeScript' } }
    const result = TemplateEngine.render('Plan: {{steps.research.output}}', {}, stepOutputs)
    expect(result).toBe('Plan: Use TypeScript')
  })

  it('should handle missing variables gracefully', () => {
    const result = TemplateEngine.render('Hello {unknown}', {})
    expect(result).toBe('Hello {unknown}')
  })
})
