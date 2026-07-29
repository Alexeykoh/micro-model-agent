import { describe, it, expect } from 'vitest'
import { extractInteractiveElements, formatSnapshot, type ElementEntry } from '../src/modules/browser/snapshot'

describe('extractInteractiveElements', () => {
  it('extracts links, buttons, inputs from HTML', () => {
    const html = `
      <html><body>
        <a href="https://example.com">Example Link</a>
        <button>Click Me</button>
        <input type="text" placeholder="Search" />
        <textarea placeholder="Comment"></textarea>
        <div role="button" aria-label="Toggle">X</div>
        <p>Not interactive</p>
      </body></html>
    `
    const elements = extractInteractiveElements(html)
    expect(elements.length).toBe(5)
    expect(elements[0].role).toBe('link')
    expect(elements[1].role).toBe('button')
    expect(elements[2].role).toBe('textbox')
    expect(elements[3].role).toBe('textbox')
    expect(elements[4].role).toBe('button')
  })

  it('assigns sequential indices starting from 1', () => {
    const html = `<html><body><a href="/a">A</a><a href="/b">B</a></body></html>`
    const elements = extractInteractiveElements(html)
    expect(elements[0].index).toBe(1)
    expect(elements[1].index).toBe(2)
  })

  it('respects maxElements limit', () => {
    const links = Array.from({ length: 50 }, (_, i) => `<a href="/${i}">Link ${i}</a>`).join('')
    const html = `<html><body>${links}</body></html>`
    const elements = extractInteractiveElements(html, 10)
    expect(elements.length).toBe(10)
  })

  it('skips hidden elements', () => {
    const html = `<html><body>
      <a href="/visible">Visible</a>
      <a href="/hidden" style="display:none">Hidden</a>
    </body></html>`
    const elements = extractInteractiveElements(html)
    expect(elements.length).toBe(1)
    expect(elements[0].name).toBe('Visible')
  })
})

describe('formatSnapshot', () => {
  it('formats elements as numbered list', () => {
    const elements: ElementEntry[] = [
      { index: 1, tag: 'a', role: 'link', name: 'Home', href: '/', visible: true },
      { index: 2, tag: 'input', role: 'textbox', name: 'Search', visible: true },
    ]
    const output = formatSnapshot({ url: 'https://example.com', title: 'Example', elements, truncated: false })
    expect(output).toContain('Page: "Example"')
    expect(output).toContain('URL: https://example.com')
    expect(output).toContain('[1] link "Home"')
    expect(output).toContain('[2] textbox "Search"')
  })

  it('shows truncation notice when truncated', () => {
    const output = formatSnapshot({ url: 'https://example.com', title: 'Test', elements: [], truncated: true })
    expect(output).toContain('more elements')
  })
})
