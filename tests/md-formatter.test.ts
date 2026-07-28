import { describe, it, expect } from 'vitest'
import { formatMarkdown } from '../src/ui/md-formatter'

describe('formatMarkdown', () => {
  it('should format headings', () => {
    const result = formatMarkdown('# Title\n## Subtitle')
    expect(result).toContain('Title')
    expect(result).toContain('Subtitle')
  })

  it('should format code blocks', () => {
    const result = formatMarkdown('```ts\nconst x = 1\n```')
    expect(result).toContain('x = 1')
  })

  it('should format inline code', () => {
    const result = formatMarkdown('Use `const` keyword')
    expect(result).toContain('const')
  })

  it('should format bold text', () => {
    const result = formatMarkdown('**bold** text')
    expect(result).toContain('bold')
    expect(result).toContain('text')
  })

  it('should format lists', () => {
    const result = formatMarkdown('- item 1\n- item 2')
    expect(result).toContain('item 1')
    expect(result).toContain('item 2')
  })
})
