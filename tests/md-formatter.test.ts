import { describe, it, expect, beforeAll } from 'vitest'
import { initTheme } from '../src/styling/index.js'
import { MdStreamFormatter, formatInlineMd, formatMdBlock, highlightCodeBlock } from '../src/ui/md-formatter.js'

beforeAll(() => {
  initTheme('dark')
})

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
}

function hasAnsi(s: string): boolean {
  return /\x1b\[[0-9;]*[a-zA-Z]/.test(s)
}

describe('formatInlineMd', () => {
  it('passes plain text through', () => {
    const result = formatInlineMd('hello world')
    expect(stripAnsi(result)).toBe('hello world')
    expect(hasAnsi(result)).toBe(false)
  })

  it('formats bold **text**', () => {
    const result = formatInlineMd('this is **bold** text')
    expect(stripAnsi(result)).toBe('this is bold text')
    expect(hasAnsi(result)).toBe(true)
  })

  it('formats inline `code`', () => {
    const result = formatInlineMd('use `useState` hook')
    expect(stripAnsi(result)).toBe('use useState hook')
    expect(hasAnsi(result)).toBe(true)
  })

  it('formats headings ##', () => {
    const result = formatInlineMd('## Hello World')
    expect(stripAnsi(result)).toBe('Hello World')
    expect(hasAnsi(result)).toBe(true)
  })

  it('formats horizontal rules ---', () => {
    const result = formatInlineMd('text\n---\nmore')
    expect(stripAnsi(result)).toBe('text\n' + '─'.repeat(40) + '\nmore')
    expect(hasAnsi(result)).toBe(true)
  })

  it('formats strikethrough ~~text~~', () => {
    const result = formatInlineMd('this is ~~strikethrough~~ text')
    expect(stripAnsi(result)).toBe('this is strikethrough text')
    expect(hasAnsi(result)).toBe(true)
  })

  it('formats links [text](url)', () => {
    const result = formatInlineMd('see [Google](https://google.com)')
    expect(stripAnsi(result)).toBe('see Google (https://google.com)')
    expect(hasAnsi(result)).toBe(true)
  })

  it('formats blockquote >', () => {
    const result = formatInlineMd('> hello world')
    expect(stripAnsi(result)).toBe('│ hello world')
    expect(hasAnsi(result)).toBe(true)
  })

  it('formats unordered list - item', () => {
    const result = formatInlineMd('- item 1\n- item 2')
    expect(stripAnsi(result)).toBe('- item 1\n- item 2')
    expect(hasAnsi(result)).toBe(true)
  })

  it('formats ordered list 1. item', () => {
    const result = formatInlineMd('1. first\n2. second')
    expect(stripAnsi(result)).toBe('1. first\n2. second')
    expect(hasAnsi(result)).toBe(true)
  })

  it('formats checkbox [x] and [ ]', () => {
    const done = formatInlineMd('- [x] completed')
    expect(stripAnsi(done)).toBe('☑ completed')
    expect(hasAnsi(done)).toBe(true)

    const todo = formatInlineMd('- [ ] pending')
    expect(stripAnsi(todo)).toBe('☐ pending')
    expect(hasAnsi(todo)).toBe(true)
  })

  it('formats table | col | col |', () => {
    const result = formatInlineMd('| a | b |\n| --- | --- |\n| 1 | 2 |')
    expect(stripAnsi(result)).toContain('│')
    expect(hasAnsi(result)).toBe(true)
  })
})

describe('highlightCodeBlock', () => {
  it('highlights JS keywords', () => {
    const result = highlightCodeBlock('const x = 1', 'javascript')
    expect(stripAnsi(result)).toBe('const x = 1')
    expect(hasAnsi(result)).toBe(true)
  })

  it('highlights TS types', () => {
    const result = highlightCodeBlock('let x: number = 1', 'typescript')
    expect(stripAnsi(result)).toBe('let x: number = 1')
    expect(hasAnsi(result)).toBe(true)
  })

  it('highlights JSON', () => {
    const result = highlightCodeBlock('{"key": "value"}', 'json')
    expect(stripAnsi(result)).toBe('{"key": "value"}')
    expect(hasAnsi(result)).toBe(true)
  })

  it('highlights Python', () => {
    const result = highlightCodeBlock('def hello(): pass', 'python')
    expect(stripAnsi(result)).toBe('def hello(): pass')
    expect(hasAnsi(result)).toBe(true)
  })

  it('highlights shell', () => {
    const result = highlightCodeBlock('npm run build', 'bash')
    expect(stripAnsi(result)).toBe('npm run build')
    expect(hasAnsi(result)).toBe(true)
  })

  it('returns plain text for unknown language', () => {
    const result = highlightCodeBlock('some code', 'unknown')
    expect(result).toBe('some code')
    expect(hasAnsi(result)).toBe(false)
  })
})

describe('formatMdBlock', () => {
  it('formats complete markdown with code block', () => {
    const md = 'Some text\n\n```typescript\nconst x: number = 1\n```\n\nEnd'
    const result = formatMdBlock(md)
    expect(stripAnsi(result)).toBe('Some text\n\n```typescript\nconst x: number = 1\n```\n\nEnd')
    expect(hasAnsi(result)).toBe(true)
  })

  it('detects language from first code line', () => {
    const md = '```\ntypescript\nconst x: number = 1\n```'
    const result = formatMdBlock(md)
    expect(stripAnsi(result)).toBe('```\nconst x: number = 1\n```')
    expect(hasAnsi(result)).toBe(true)
  })
})

describe('MdStreamFormatter', () => {
  it('passes plain text through', () => {
    const f = new MdStreamFormatter()
    const out = f.push('hello world')
    expect(stripAnsi(out)).toBe('hello world')
    expect(f.push(' more')).toBe(' more')
    expect(stripAnsi(f.flush())).toBe('')
  })

  it('handles code block in single chunk', () => {
    const f = new MdStreamFormatter()
    const md = 'text\n```typescript\nconst x = 1\n```\nend'
    const out = f.push(md)
    expect(stripAnsi(out)).toBe('text\n```typescript\nconst x = 1\n```\n\nend')
    expect(hasAnsi(out)).toBe(true)
  })

  it('handles code block across multiple chunks', () => {
    const f = new MdStreamFormatter()
    const out1 = f.push('some text\n```typescript\n')
    expect(stripAnsi(out1)).toBe('some text\n```typescript\n')
    expect(f.push('const x = 1\n')).toBe('') // code mode, buffers
    const out2 = f.push('const y = 2\n```\nend')
    expect(stripAnsi(out2)).toContain('end')
    expect(hasAnsi(out2)).toBe(true)
  })

  it('detects language from first code line when fence has no lang', () => {
    const f = new MdStreamFormatter()
    const md = 'text\n```\ntypescript\nconst x: number = 1\n```\nend'
    const out = f.push(md)
    expect(stripAnsi(out)).toBe('text\n```typescript\nconst x: number = 1\n```\n\nend')
    expect(hasAnsi(out)).toBe(true)
  })

  it('detects language across chunks', () => {
    const f = new MdStreamFormatter()
    f.push('text\n```\n')
    f.push('typescript\n')
    const out = f.push('const x = 1\n```\nend')
    expect(stripAnsi(out)).toContain('end')
    expect(hasAnsi(out)).toBe(true)
  })

  it('flushes unclosed code block', () => {
    const f = new MdStreamFormatter()
    f.push('text\n```typescript\nconst x = 1\n')
    const out = f.flush()
    expect(stripAnsi(out)).toContain('const x = 1')
    expect(stripAnsi(out)).toContain('```')
  })

  it('resets state', () => {
    const f = new MdStreamFormatter()
    f.push('text\n```typescript\ncode\n')
    f.reset()
    expect(f.flush()).toBe('')
  })

  it('formats inline markdown in text', () => {
    const f = new MdStreamFormatter()
    const out = f.push('this is **bold** and `code`')
    expect(stripAnsi(out)).toBe('this is bold and code')
    expect(hasAnsi(out)).toBe(true)
  })
})
