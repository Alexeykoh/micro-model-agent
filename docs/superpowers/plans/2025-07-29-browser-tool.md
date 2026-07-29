# Browser Tool (Playwright) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Playwright-based browser tool that lets the agent navigate, click, type, scroll, and take screenshots on real web pages — with an accessibility-tree fallback for non-vision models.

**Architecture:** Single `browser` tool with action-based dispatch. `BrowserSession` manages a persistent Playwright browser instance. Each action returns a compact numbered-element snapshot (accessibility tree) so 9B models can interact without parsing raw HTML. Vision-capable models additionally receive screenshots. Cookies/sessions persist across agent runs via `CookieStore`.

**Tech Stack:** Playwright (Chromium), TypeScript ES2022, Bun, vitest

---

## File Structure

```
src/modules/browser/
├── types.ts            # BrowserState, ElementEntry, BrowserAction, BrowserConfig
├── session.ts          # BrowserSession — Playwright lifecycle, action dispatch
├── snapshot.ts         # Page → numbered accessibility tree (interactive elements)
├── actions.ts          # Individual action implementations (click, type, scroll, etc.)
├── cookie-store.ts     # Cookie/session persistence to disk (~/.mma/browser/)
├── module.ts           # AgentModule — PromptBlock + Plugin hooks
└── index.ts            # Re-exports

src/tools/browser.ts    # Tool definition — action dispatch to BrowserSession

tests/
├── browser-snapshot.test.ts
├── browser-actions.test.ts
├── browser-session.test.ts
├── browser-cookie-store.test.ts
└── tools/browser.test.ts
```

**Responsibilities:**
- `types.ts` — All interfaces, no logic
- `session.ts` — Playwright browser/context/page lifecycle, action dispatch, state management
- `snapshot.ts` — Extract interactive elements from page, assign numbers, format as text
- `actions.ts` — Each action (click, type, scroll, open, back, screenshot, close) as a pure function
- `cookie-store.ts` — Save/load cookies + localStorage to JSON file
- `module.ts` — AgentModule integration (system prompt block, plugin hooks for cleanup)
- `browser.ts` (tool) — ToolDefinition with action parameter, delegates to BrowserSession

---

### Task 1: Add Playwright dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install playwright**

```bash
bun add playwright
```

- [ ] **Step 2: Install Chromium browser**

```bash
bunx playwright install chromium
```

- [ ] **Step 3: Verify installation**

Run: `bunx playwright --version`
Expected: version printed without errors

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock
git commit -m "feat: add playwright dependency"
```

---

### Task 2: Browser types

**Files:**
- Create: `src/modules/browser/types.ts`
- Create: `tests/browser-snapshot.test.ts` (skeleton)

- [ ] **Step 1: Write the failing test for types existence**

```typescript
// tests/browser-snapshot.test.ts
import { describe, it, expect } from 'vitest'

describe('browser types', () => {
  it('exports required types', async () => {
    const types = await import('../src/modules/browser/types')
    expect(types).toBeDefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/browser-snapshot.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create types.ts**

```typescript
// src/modules/browser/types.ts

export type BrowserAction =
  | 'open'
  | 'click'
  | 'type'
  | 'scroll'
  | 'back'
  | 'forward'
  | 'screenshot'
  | 'snapshot'
  | 'close'
  | 'wait'

export interface ElementEntry {
  index: number
  tag: string
  role: string
  name: string
  value?: string
  href?: string
  visible: boolean
}

export interface PageSnapshot {
  url: string
  title: string
  elements: ElementEntry[]
  truncated: boolean
}

export interface BrowserState {
  isOpen: boolean
  url: string | null
  title: string | null
  elementCount: number
}

export interface BrowserConfig {
  headless: boolean
  maxElements: number
  screenshotMaxWidth: number
  cookieDir: string
  viewportWidth: number
  viewportHeight: number
  navigationTimeout: number
}

export interface ActionResult {
  success: boolean
  output: string
  screenshot?: Buffer
}

export const DEFAULT_BROWSER_CONFIG: BrowserConfig = {
  headless: true,
  maxElements: 30,
  screenshotMaxWidth: 1280,
  cookieDir: '',
  viewportWidth: 1280,
  viewportHeight: 720,
  navigationTimeout: 15000,
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/browser-snapshot.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/browser/types.ts tests/browser-snapshot.test.ts
git commit -m "feat: add browser types"
```

---

### Task 3: Snapshot — accessibility tree extraction

**Files:**
- Create: `src/modules/browser/snapshot.ts`
- Modify: `tests/browser-snapshot.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/browser-snapshot.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/browser-snapshot.test.ts`
Expected: FAIL — `extractInteractiveElements` not defined

- [ ] **Step 3: Implement snapshot.ts**

```typescript
// src/modules/browser/snapshot.ts
import type { ElementEntry, PageSnapshot } from './types'

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'textarea',
  'select',
  '[role="button"]',
  '[role="link"]',
  '[role="textbox"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[contenteditable="true"]',
].join(',')

function inferRole(tag: string, type?: string): string {
  const t = tag.toLowerCase()
  if (t === 'a') return 'link'
  if (t === 'button') return 'button'
  if (t === 'input') {
    const inputType = type?.toLowerCase()
    if (inputType === 'submit' || inputType === 'button') return 'button'
    if (inputType === 'checkbox') return 'checkbox'
    if (inputType === 'radio') return 'radio'
    return 'textbox'
  }
  if (t === 'textarea') return 'textbox'
  if (t === 'select') return 'combobox'
  return 'widget'
}

function getName(tag: string, attrs: Record<string, string>): string {
  return (
    attrs['aria-label'] ||
    attrs['placeholder'] ||
    attrs['title'] ||
    attrs['alt'] ||
    attrs['value'] ||
    attrs['name'] ||
    ''
  )
}

export function extractInteractiveElements(html: string, maxElements = 30): ElementEntry[] {
  const elements: ElementEntry[] = []
  const tagRegex = /<(a|button|input|textarea|select|div|span)([^>]*)>/gi
  let match: RegExpExecArray | null

  while ((match = tagRegex.exec(html)) !== null) {
    if (elements.length >= maxElements) break

    const tag = match[1].toLowerCase()
    const attrStr = match[2]

    const attrs: Record<string, string> = {}
    const attrRegex = /(\w[\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g
    let attrMatch: RegExpExecArray | null
    while ((attrMatch = attrRegex.exec(attrStr)) !== null) {
      attrs[attrMatch[1].toLowerCase()] = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? ''
    }

    if (attrs['style']?.includes('display:none') || attrs['style']?.includes('display: none')) continue
    if (attrs['hidden'] !== undefined) continue
    if (attrs['aria-hidden'] === 'true') continue
    if (tag === 'input' && attrs['type'] === 'hidden') continue

    const role = attrs['role'] || inferRole(tag, attrs['type'])
    const isInteractive = [
      'a', 'button', 'input', 'textarea', 'select',
    ].includes(tag) || attrs['role'] !== undefined

    if (!isInteractive) continue
    if (tag === 'a' && !attrs['href']) continue

    const name = getName(tag, attrs)

    elements.push({
      index: elements.length + 1,
      tag,
      role,
      name,
      value: attrs['value'],
      href: attrs['href'],
      visible: true,
    })
  }

  return elements
}

export function formatSnapshot(snapshot: PageSnapshot): string {
  const lines: string[] = []
  lines.push(`Page: "${snapshot.title}"`)
  lines.push(`URL: ${snapshot.url}`)
  lines.push('')

  if (snapshot.elements.length === 0) {
    lines.push('(no interactive elements on page)')
    return lines.join('\n')
  }

  for (const el of snapshot.elements) {
    let line = `[${el.index}] ${el.role}`
    if (el.name) line += ` "${el.name}"`
    if (el.href) line += ` → ${el.href}`
    if (el.value) line += ` = "${el.value}"`
    lines.push(line)
  }

  if (snapshot.truncated) {
    lines.push('')
    lines.push(`... and more elements not shown. Use scroll or search to find others.`)
  }

  return lines.join('\n')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/browser-snapshot.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/modules/browser/snapshot.ts tests/browser-snapshot.test.ts
git commit -m "feat: add browser snapshot extraction"
```

---

### Task 4: Cookie store — session persistence

**Files:**
- Create: `src/modules/browser/cookie-store.ts`
- Create: `tests/browser-cookie-store.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/browser-cookie-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { CookieStore } from '../src/modules/browser/cookie-store'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('CookieStore', () => {
  let dir: string
  let store: CookieStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mma-browser-test-'))
    store = new CookieStore(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('saves and loads cookies', async () => {
    const cookies = [
      { name: 'session', value: 'abc123', domain: '.example.com', path: '/' },
      { name: 'pref', value: 'dark', domain: '.example.com', path: '/' },
    ]
    await store.save(cookies)
    const loaded = await store.load()
    expect(loaded).toEqual(cookies)
  })

  it('returns empty array when no file exists', async () => {
    const loaded = await store.load()
    expect(loaded).toEqual([])
  })

  it('saves to cookies.json file', async () => {
    await store.save([{ name: 'x', value: 'y', domain: '.test.com', path: '/' }])
    const filePath = join(dir, 'cookies.json')
    expect(existsSync(filePath)).toBe(true)
    const content = JSON.parse(readFileSync(filePath, 'utf-8'))
    expect(content).toHaveLength(1)
    expect(content[0].name).toBe('x')
  })

  it('clears cookies', async () => {
    await store.save([{ name: 'x', value: 'y', domain: '.test.com', path: '/' }])
    await store.clear()
    const loaded = await store.load()
    expect(loaded).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/browser-cookie-store.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement cookie-store.ts**

```typescript
// src/modules/browser/cookie-store.ts
import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'

export interface StoredCookie {
  name: string
  value: string
  domain: string
  path: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

export class CookieStore {
  private filePath: string

  constructor(cookieDir: string) {
    this.filePath = join(cookieDir, 'cookies.json')
  }

  async save(cookies: StoredCookie[]): Promise<void> {
    await mkdir(join(this.filePath, '..'), { recursive: true })
    await writeFile(this.filePath, JSON.stringify(cookies, null, 2), 'utf-8')
  }

  async load(): Promise<StoredCookie[]> {
    try {
      const data = await readFile(this.filePath, 'utf-8')
      return JSON.parse(data)
    } catch {
      return []
    }
  }

  async clear(): Promise<void> {
    await this.save([])
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/browser-cookie-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/browser/cookie-store.ts tests/browser-cookie-store.test.ts
git commit -m "feat: add browser cookie store for session persistence"
```

---

### Task 5: Browser actions

**Files:**
- Create: `src/modules/browser/actions.ts`
- Create: `tests/browser-actions.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/browser-actions.test.ts
import { describe, it, expect } from 'vitest'
import { buildClickScript, buildTypeScript, buildScrollScript } from '../src/modules/browser/actions'

describe('buildClickScript', () => {
  it('generates script that clicks element by index', () => {
    const script = buildClickScript(3)
    expect(script).toContain('data-browser-index')
    expect(script).toContain('3')
    expect(script).toContain('.click()')
  })
})

describe('buildTypeScript', () => {
  it('generates script that types text into element', () => {
    const script = buildTypeScript(2, 'hello world')
    expect(script).toContain('data-browser-index')
    expect(script).toContain('2')
    expect(script).toContain('hello world')
    expect(script).toContain('.value')
  })

  it('escapes special characters in text', () => {
    const script = buildTypeScript(1, 'test"quote\\backslash')
    expect(script).not.toContain('test"quote')
    expect(script).toContain('JSON.parse')
  })
})

describe('buildScrollScript', () => {
  it('generates scroll down script', () => {
    const script = buildScrollScript('down')
    expect(script).toContain('scrollBy')
    expect(script).toContain('0')
  })

  it('generates scroll up script', () => {
    const script = buildScrollScript('up')
    expect(script).toContain('scrollBy')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/browser-actions.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement actions.ts**

```typescript
// src/modules/browser/actions.ts

export function buildClickScript(elementIndex: number): string {
  return `
    const el = document.querySelector('[data-browser-index="${elementIndex}"]');
    if (!el) throw new Error('Element not found: ${elementIndex}');
    el.click();
  `
}

export function buildTypeScript(elementIndex: number, text: string): string {
  const escaped = JSON.stringify(text)
  return `
    const el = document.querySelector('[data-browser-index="${elementIndex}"]');
    if (!el) throw new Error('Element not found: ${elementIndex}');
    const text = JSON.parse(${JSON.stringify(escaped)});
    el.focus();
    el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  `
}

export function buildScrollScript(direction: 'up' | 'down' | 'top' | 'bottom'): string {
  switch (direction) {
    case 'down':
      return `window.scrollBy({ top: 600, behavior: 'smooth' })`
    case 'up':
      return `window.scrollBy({ top: -600, behavior: 'smooth' })`
    case 'top':
      return `window.scrollTo({ top: 0, behavior: 'smooth' })`
    case 'bottom':
      return `window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })`
  }
}

export function buildWaitScript(timeoutMs: number): string {
  return `await new Promise(r => setTimeout(r, ${timeoutMs}))`
}

export function buildIndexInjectionScript(): string {
  return `
    const selectors = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [contenteditable="true"]';
    const elements = document.querySelectorAll(selectors);
    let idx = 1;
    elements.forEach(el => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      el.setAttribute('data-browser-index', String(idx++));
    });
  `
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/browser-actions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/browser/actions.ts tests/browser-actions.test.ts
git commit -m "feat: add browser action script builders"
```

---

### Task 6: Browser session — Playwright lifecycle

**Files:**
- Create: `src/modules/browser/session.ts`
- Create: `tests/browser-session.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/browser-session.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { BrowserSession } from '../src/modules/browser/session'
import { DEFAULT_BROWSER_CONFIG } from '../src/modules/browser/types'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('BrowserSession', () => {
  let session: BrowserSession | null = null
  const cookieDir = mkdtempSync(join(tmpdir(), 'mma-browser-sess-'))

  afterEach(async () => {
    if (session) {
      await session.close()
      session = null
    }
    rmSync(cookieDir, { recursive: true, force: true })
  })

  it('starts in closed state', () => {
    session = new BrowserSession({ ...DEFAULT_BROWSER_CONFIG, cookieDir })
    const state = session.getState()
    expect(state.isOpen).toBe(false)
    expect(state.url).toBeNull()
  })

  it('opens a page and returns snapshot', async () => {
    session = new BrowserSession({ ...DEFAULT_BROWSER_CONFIG, cookieDir })
    const result = await session.execute('open', { url: 'https://example.com' })
    expect(result.success).toBe(true)
    expect(result.output).toContain('Example Domain')
    const state = session.getState()
    expect(state.isOpen).toBe(true)
    expect(state.url).toContain('example.com')
  }, 30000)

  it('returns error for unknown action', async () => {
    session = new BrowserSession({ ...DEFAULT_BROWSER_CONFIG, cookieDir })
    const result = await session.execute('invalid_action' as any, {})
    expect(result.success).toBe(false)
    expect(result.output).toContain('Unknown action')
  })

  it('returns error when clicking without open page', async () => {
    session = new BrowserSession({ ...DEFAULT_BROWSER_CONFIG, cookieDir })
    const result = await session.execute('click', { target: 1 })
    expect(result.success).toBe(false)
    expect(result.output).toContain('No page open')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/browser-session.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement session.ts**

```typescript
// src/modules/browser/session.ts
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import type { BrowserConfig, BrowserState, ActionResult } from './types'
import { extractInteractiveElements, formatSnapshot } from './snapshot'
import { buildClickScript, buildTypeScript, buildScrollScript, buildIndexInjectionScript } from './actions'
import { CookieStore, type StoredCookie } from './cookie-store'

export class BrowserSession {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private page: Page | null = null
  private config: BrowserConfig
  private cookieStore: CookieStore
  private state: BrowserState = { isOpen: false, url: null, title: null, elementCount: 0 }

  constructor(config: BrowserConfig) {
    this.config = config
    this.cookieStore = new CookieStore(config.cookieDir)
  }

  getState(): BrowserState {
    return { ...this.state }
  }

  async execute(action: string, args: Record<string, unknown>): Promise<ActionResult> {
    try {
      switch (action) {
        case 'open': return await this.open(String(args.url || ''))
        case 'click': return await this.click(Number(args.target))
        case 'type': return await this.type(Number(args.target), String(args.text || ''))
        case 'scroll': return await this.scroll(String(args.direction || 'down'))
        case 'back': return await this.back()
        case 'forward': return await this.forward()
        case 'screenshot': return await this.screenshot()
        case 'snapshot': return await this.snapshot()
        case 'close': return await this.close()
        case 'wait': return await this.wait(Number(args.ms || 1000))
        default: return { success: false, output: `Unknown action: ${action}` }
      }
    } catch (err: any) {
      return { success: false, output: `Browser error: ${err.message}` }
    }
  }

  private async ensurePage(): Promise<ActionResult | null> {
    if (!this.page) {
      return { success: false, output: 'No page open. Use action "open" first.' }
    }
    return null
  }

  private async launch(): Promise<void> {
    if (this.browser) return

    this.browser = await chromium.launch({ headless: this.config.headless })
    this.context = await this.browser.newContext({
      viewport: { width: this.config.viewportWidth, height: this.config.viewportHeight },
    })

    const savedCookies = await this.cookieStore.load()
    if (savedCookies.length > 0) {
      await this.context.addCookies(savedCookies.map(c => ({
        ...c,
        sameSite: c.sameSite as any,
      })))
    }

    this.page = await this.context.newPage()
    this.page.setDefaultTimeout(this.config.navigationTimeout)
  }

  private async saveCookies(): Promise<void> {
    if (!this.context) return
    const cookies = await this.context.cookies()
    await this.cookieStore.save(cookies as StoredCookie[])
  }

  private async takeSnapshot(): Promise<string> {
    if (!this.page) return 'No page open.'

    await this.page.evaluate(buildIndexInjectionScript())
    const html = await this.page.content()
    const url = this.page.url()
    const title = await this.page.title()

    const allElements = extractInteractiveElements(html, this.config.maxElements + 5)
    const truncated = allElements.length > this.config.maxElements
    const elements = allElements.slice(0, this.config.maxElements)

    this.state = {
      isOpen: true,
      url,
      title,
      elementCount: elements.length,
    }

    return formatSnapshot({ url, title, elements, truncated })
  }

  private async open(url: string): Promise<ActionResult> {
    if (!url) return { success: false, output: 'URL is required' }

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url
    }

    await this.launch()
    if (!this.page) return { success: false, output: 'Failed to create page' }

    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.config.navigationTimeout })
    } catch (err: any) {
      return { success: false, output: `Navigation failed: ${err.message}` }
    }

    const snapshot = await this.takeSnapshot()
    await this.saveCookies()
    return { success: true, output: snapshot }
  }

  private async click(target: number): Promise<ActionResult> {
    const err = await this.ensurePage()
    if (err) return err
    if (!this.page) return { success: false, output: 'No page' }

    if (!target || target < 1) {
      return { success: false, output: 'Invalid target. Provide element number from snapshot.' }
    }

    try {
      const script = buildClickScript(target)
      const result = await this.page.evaluate(script)
      await this.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})
      await new Promise(r => setTimeout(r, 500))
      const snapshot = await this.takeSnapshot()
      await this.saveCookies()
      return { success: true, output: snapshot }
    } catch (err: any) {
      return { success: false, output: `Click failed: ${err.message}. Check element number.` }
    }
  }

  private async type(target: number, text: string): Promise<ActionResult> {
    const err = await this.ensurePage()
    if (err) return err
    if (!this.page) return { success: false, output: 'No page' }

    if (!target || target < 1) {
      return { success: false, output: 'Invalid target.' }
    }
    if (!text) {
      return { success: false, output: 'Text is required.' }
    }

    try {
      const script = buildTypeScript(target, text)
      await this.page.evaluate(script)
      const snapshot = await this.takeSnapshot()
      return { success: true, output: snapshot }
    } catch (err: any) {
      return { success: false, output: `Type failed: ${err.message}` }
    }
  }

  private async scroll(direction: string): Promise<ActionResult> {
    const err = await this.ensurePage()
    if (err) return err
    if (!this.page) return { success: false, output: 'No page' }

    const dir = direction as 'up' | 'down' | 'top' | 'bottom'
    if (!['up', 'down', 'top', 'bottom'].includes(dir)) {
      return { success: false, output: 'Direction must be: up, down, top, bottom' }
    }

    try {
      await this.page.evaluate(buildScrollScript(dir))
      await new Promise(r => setTimeout(r, 300))
      const snapshot = await this.takeSnapshot()
      return { success: true, output: snapshot }
    } catch (err: any) {
      return { success: false, output: `Scroll failed: ${err.message}` }
    }
  }

  private async back(): Promise<ActionResult> {
    const err = await this.ensurePage()
    if (err) return err
    if (!this.page) return { success: false, output: 'No page' }

    await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: this.config.navigationTimeout }).catch(() => {})
    await new Promise(r => setTimeout(r, 300))
    const snapshot = await this.takeSnapshot()
    return { success: true, output: snapshot }
  }

  private async forward(): Promise<ActionResult> {
    const err = await this.ensurePage()
    if (err) return err
    if (!this.page) return { success: false, output: 'No page' }

    await this.page.goForward({ waitUntil: 'domcontentloaded', timeout: this.config.navigationTimeout }).catch(() => {})
    await new Promise(r => setTimeout(r, 300))
    const snapshot = await this.takeSnapshot()
    return { success: true, output: snapshot }
  }

  private async screenshot(): Promise<ActionResult> {
    const err = await this.ensurePage()
    if (err) return err
    if (!this.page) return { success: false, output: 'No page' }

    const buffer = await this.page.screenshot({ type: 'png', fullPage: false })
    const snapshot = await this.takeSnapshot()
    return { success: true, output: snapshot, screenshot: buffer }
  }

  private async snapshot(): Promise<ActionResult> {
    const err = await this.ensurePage()
    if (err) return err
    const snap = await this.takeSnapshot()
    return { success: true, output: snap }
  }

  private async wait(ms: number): Promise<ActionResult> {
    const err = await this.ensurePage()
    if (err) return err
    await new Promise(r => setTimeout(r, Math.min(ms, 10000)))
    const snapshot = await this.takeSnapshot()
    return { success: true, output: snapshot }
  }

  async close(): Promise<ActionResult> {
    await this.saveCookies()
    if (this.page) {
      await this.page.close().catch(() => {})
      this.page = null
    }
    if (this.context) {
      await this.context.close().catch(() => {})
      this.context = null
    }
    if (this.browser) {
      await this.browser.close().catch(() => {})
      this.browser = null
    }
    this.state = { isOpen: false, url: null, title: null, elementCount: 0 }
    return { success: true, output: 'Browser closed.' }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/browser-session.test.ts`
Expected: PASS (tests that open example.com may take ~10s)

- [ ] **Step 5: Commit**

```bash
git add src/modules/browser/session.ts tests/browser-session.test.ts
git commit -m "feat: add browser session with Playwright lifecycle"
```

---

### Task 7: Browser tool definition

**Files:**
- Create: `src/tools/browser.ts`
- Create: `tests/tools/browser.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/tools/browser.test.ts
import { describe, it, expect } from 'vitest'
import { createBrowserTool } from '../../src/tools/browser'

describe('createBrowserTool', () => {
  it('has correct tool definition', () => {
    const tool = createBrowserTool()
    expect(tool.name).toBe('browser')
    expect(tool.description).toBeTruthy()
    expect(tool.parameters.type).toBe('object')
    const props = tool.parameters.properties as Record<string, any>
    expect(props.action).toBeDefined()
    expect(props.action.enum).toContain('open')
    expect(props.action.enum).toContain('click')
    expect(props.action.enum).toContain('type')
    expect(props.action.enum).toContain('scroll')
    expect(props.action.enum).toContain('screenshot')
    expect(props.action.enum).toContain('close')
    expect(tool.parameters.required).toContain('action')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/tools/browser.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement browser.ts tool**

```typescript
// src/tools/browser.ts
import type { ToolDefinition, ToolContext, ToolResult } from './types'
import { BrowserSession } from '../modules/browser/session'
import { DEFAULT_BROWSER_CONFIG } from '../modules/browser/types'
import { join } from 'path'

let session: BrowserSession | null = null

function getSession(ctx: ToolContext): BrowserSession {
  if (!session) {
    const cookieDir = join(ctx.baseDir, '.mma', 'browser')
    session = new BrowserSession({
      ...DEFAULT_BROWSER_CONFIG,
      cookieDir,
    })
  }
  return session
}

export function createBrowserTool(): ToolDefinition {
  return {
    name: 'browser',
    description: [
      'Control a headless browser. Navigate pages, click elements, type text, scroll, take screenshots.',
      'Returns a numbered list of interactive elements — use element numbers as targets for click/type.',
      'Actions: open (url), click (target), type (target, text), scroll (direction), back, forward, screenshot, snapshot, close, wait (ms).',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['open', 'click', 'type', 'scroll', 'back', 'forward', 'screenshot', 'snapshot', 'close', 'wait'],
          description: 'Browser action to perform',
        },
        url: {
          type: 'string',
          description: 'URL to open (for action "open")',
        },
        target: {
          type: 'number',
          description: 'Element number from snapshot (for action "click" or "type")',
        },
        text: {
          type: 'string',
          description: 'Text to type (for action "type")',
        },
        direction: {
          type: 'string',
          enum: ['up', 'down', 'top', 'bottom'],
          description: 'Scroll direction (for action "scroll", default "down")',
        },
        ms: {
          type: 'number',
          description: 'Milliseconds to wait (for action "wait", default 1000)',
        },
      },
      required: ['action'],
    },
    handler: async (ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> => {
      const action = String(args.action || '')
      if (!action) {
        return { success: false, output: 'Action is required.' }
      }

      const s = getSession(ctx)
      const result = await s.execute(action, args)

      if (result.screenshot) {
        const base64 = result.screenshot.toString('base64')
        return {
          success: result.success,
          output: result.output + `\n\n[Screenshot: data:image/png;base64,${base64.slice(0, 100)}... (${base64.length} bytes)]`,
        }
      }

      return { success: result.success, output: result.output }
    },
  }
}

export function closeBrowserSession(): void {
  if (session) {
    session.close().catch(() => {})
    session = null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/tools/browser.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/browser.ts tests/tools/browser.test.ts
git commit -m "feat: add browser tool definition"
```

---

### Task 8: Browser module — AgentModule integration

**Files:**
- Create: `src/modules/browser/module.ts`
- Create: `src/modules/browser/index.ts`

- [ ] **Step 1: Create module.ts**

```typescript
// src/modules/browser/module.ts
import type { AgentModule, AgentPlugin } from '../types'
import type { PromptBlock } from '../../core/types'
import type { ToolDefinition } from '../../tools/types'
import { createBrowserTool, closeBrowserSession } from '../../tools/browser'

export class BrowserModule implements AgentModule {
  name = 'browser'

  getSystemPromptBlock(): PromptBlock | null {
    return {
      content: [
        'You have a headless browser tool. Use it to navigate websites, click links, fill forms, and read page content.',
        'Workflow: open(url) → read snapshot → click/type on element numbers → read updated snapshot.',
        'Always start with "open" action. Use element numbers from snapshot for click/type targets.',
        'Use "screenshot" action only if the model supports vision. Otherwise rely on the text snapshot.',
      ].join('\n'),
      priority: 'normal',
      essential: false,
      estimatedTokens: 80,
    }
  }

  getToolDefinitions(): ToolDefinition[] {
    return [createBrowserTool()]
  }

  getPlugin(): AgentPlugin {
    return {
      name: 'browser',
      onSessionEnd: () => {
        closeBrowserSession()
      },
    }
  }
}
```

- [ ] **Step 2: Create index.ts**

```typescript
// src/modules/browser/index.ts
export { BrowserModule } from './module'
export { BrowserSession } from './session'
export { CookieStore } from './cookie-store'
export { extractInteractiveElements, formatSnapshot } from './snapshot'
export type { BrowserConfig, BrowserState, ActionResult, ElementEntry, PageSnapshot } from './types'
export { DEFAULT_BROWSER_CONFIG } from './types'
```

- [ ] **Step 3: Verify compilation**

Run: `tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/modules/browser/module.ts src/modules/browser/index.ts
git commit -m "feat: add browser module with AgentModule integration"
```

---

### Task 9: Register browser module in bootstrap + tool index

**Files:**
- Modify: `src/tools/index.ts`
- Modify: `src/core/bootstrap.ts`
- Modify: `src/config/types.ts`
- Modify: `src/config/defaults.ts`

- [ ] **Step 1: Add browser config to types.ts**

In `src/config/types.ts`, add the `BrowserConfig` interface:

```typescript
export interface BrowserToolConfig {
  enabled: boolean
  headless: boolean
  maxElements: number
  viewportWidth: number
  viewportHeight: number
  navigationTimeout: number
}
```

Add to `AppConfig`:

```typescript
  browser: BrowserToolConfig
```

- [ ] **Step 2: Add browser defaults to defaults.ts**

```typescript
  browser: {
    enabled: true,
    headless: true,
    maxElements: 30,
    viewportWidth: 1280,
    viewportHeight: 720,
    navigationTimeout: 15000,
  },
```

- [ ] **Step 3: Register browser tool in tools/index.ts**

Add import:

```typescript
import { createBrowserTool } from './browser'
```

Add to `registerAllTools` function, inside the `tools` array:

```typescript
    createBrowserTool(),
```

Add to exports:

```typescript
  createBrowserTool,
```

- [ ] **Step 4: Register BrowserModule in bootstrap.ts**

Add import:

```typescript
import { BrowserModule } from '../modules/browser/index'
```

After `moduleRegistry.register(skillsModule)`:

```typescript
  if (config.browser.enabled) {
    const browserModule = new BrowserModule()
    moduleRegistry.register(browserModule)
    const browserPlugin = browserModule.getPlugin()
    if (browserPlugin) {
      pluginManager.register(browserPlugin)
    }
  }
```

- [ ] **Step 5: Run typecheck**

Run: `tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Run all tests**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/config/types.ts src/config/defaults.ts src/tools/index.ts src/core/bootstrap.ts
git commit -m "feat: register browser module in bootstrap and config"
```

---

### Task 10: Vision fallback — screenshot handling for non-vision models

**Files:**
- Modify: `src/tools/browser.ts`
- Modify: `src/modules/browser/types.ts`
- Create: `tests/tools/browser-vision-fallback.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/tools/browser-vision-fallback.test.ts
import { describe, it, expect } from 'vitest'
import { formatScreenshotResult, formatScreenshotForTextModel } from '../../src/tools/browser'

describe('formatScreenshotForTextModel', () => {
  it('returns text-only message without base64 data', () => {
    const snapshot = 'Page: "Test"\nURL: https://test.com\n[1] link "Home"'
    const result = formatScreenshotForTextModel(snapshot)
    expect(result).toContain('Screenshot captured')
    expect(result).toContain(snapshot)
    expect(result).not.toContain('base64')
    expect(result).not.toContain('data:image')
  })
})

describe('formatScreenshotResult', () => {
  it('includes base64 for vision models', () => {
    const snapshot = 'Page: "Test"'
    const buffer = Buffer.from('fake-png-data')
    const result = formatScreenshotResult(snapshot, buffer, true)
    expect(result).toContain('data:image/png;base64,')
  })

  it('excludes base64 for non-vision models', () => {
    const snapshot = 'Page: "Test"'
    const buffer = Buffer.from('fake-png-data')
    const result = formatScreenshotResult(snapshot, buffer, false)
    expect(result).not.toContain('data:image')
    expect(result).toContain('Screenshot captured')
    expect(result).toContain(snapshot)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/tools/browser-vision-fallback.test.ts`
Expected: FAIL — functions not defined

- [ ] **Step 3: Add vision detection to types.ts**

Add to `src/modules/browser/types.ts`:

```typescript
export interface VisionCapability {
  supportsScreenshots: boolean
}
```

- [ ] **Step 4: Add formatting functions to browser.ts tool**

Add these exported functions to `src/tools/browser.ts`:

```typescript
export function formatScreenshotForTextModel(snapshot: string): string {
  return `[Screenshot captured — image not available for text-only model]\n\n${snapshot}`
}

export function formatScreenshotResult(snapshot: string, screenshot: Buffer, supportsVision: boolean): string {
  if (!supportsVision) {
    return formatScreenshotForTextModel(snapshot)
  }
  const base64 = screenshot.toString('base64')
  return `${snapshot}\n\n[Screenshot: data:image/png;base64,${base64}]`
}
```

- [ ] **Step 5: Update handler in browser.ts to use vision detection**

Replace the screenshot handling in the handler:

```typescript
    handler: async (ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> => {
      const action = String(args.action || '')
      if (!action) {
        return { success: false, output: 'Action is required.' }
      }

      const s = getSession(ctx)
      const result = await s.execute(action, args)

      const supportsVision = ctx.config.model.includes('vision') ||
        ctx.config.model.includes('gpt-4o') ||
        ctx.config.model.includes('claude')

      if (result.screenshot) {
        return {
          success: result.success,
          output: formatScreenshotResult(result.output, result.screenshot, supportsVision),
        }
      }

      return { success: result.success, output: result.output }
    },
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/tools/browser-vision-fallback.test.ts`
Expected: PASS

- [ ] **Step 7: Run all tests**

Run: `bun test`
Expected: All pass

- [ ] **Step 8: Commit**

```bash
git add src/tools/browser.ts src/modules/browser/types.ts tests/tools/browser-vision-fallback.test.ts
git commit -m "feat: add vision fallback for non-vision models"
```

---

### Task 11: Stuck detection for browser actions

**Files:**
- Modify: `src/modules/browser/session.ts`
- Create: `tests/browser-stuck-detection.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/browser-stuck-detection.test.ts
import { describe, it, expect } from 'vitest'
import { BrowserActionTracker } from '../src/modules/browser/session'

describe('BrowserActionTracker', () => {
  it('detects repeated same action on same URL', () => {
    const tracker = new BrowserActionTracker(3)
    tracker.record('click', { target: 1 }, 'https://example.com')
    tracker.record('click', { target: 1 }, 'https://example.com')
    const warning = tracker.record('click', { target: 1 }, 'https://example.com')
    expect(warning).toBeTruthy()
    expect(warning).toContain('repeated')
  })

  it('does not warn for different actions', () => {
    const tracker = new BrowserActionTracker(3)
    tracker.record('click', { target: 1 }, 'https://example.com')
    tracker.record('type', { target: 2, text: 'hi' }, 'https://example.com')
    const warning = tracker.record('scroll', { direction: 'down' }, 'https://example.com')
    expect(warning).toBeNull()
  })

  it('does not warn for different URLs', () => {
    const tracker = new BrowserActionTracker(3)
    tracker.record('click', { target: 1 }, 'https://example.com')
    tracker.record('click', { target: 1 }, 'https://other.com')
    const warning = tracker.record('click', { target: 1 }, 'https://third.com')
    expect(warning).toBeNull()
  })

  it('resets after navigation', () => {
    const tracker = new BrowserActionTracker(3)
    tracker.record('click', { target: 1 }, 'https://example.com')
    tracker.record('click', { target: 1 }, 'https://example.com')
    tracker.reset()
    const warning = tracker.record('click', { target: 1 }, 'https://example.com')
    expect(warning).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/browser-stuck-detection.test.ts`
Expected: FAIL — `BrowserActionTracker` not defined

- [ ] **Step 3: Add BrowserActionTracker to session.ts**

Add at the top of `src/modules/browser/session.ts`:

```typescript
export class BrowserActionTracker {
  private history: Array<{ action: string; args: Record<string, unknown>; url: string }> = []
  private threshold: number

  constructor(threshold = 3) {
    this.threshold = threshold
  }

  record(action: string, args: Record<string, unknown>, url: string): string | null {
    this.history.push({ action, args, url })

    if (this.history.length < this.threshold) return null

    const recent = this.history.slice(-this.threshold)
    const allSame = recent.every(
      h => h.action === recent[0].action &&
        h.url === recent[0].url &&
        JSON.stringify(h.args) === JSON.stringify(recent[0].args)
    )

    if (allSame) {
      return `You have repeated the same action (${action}) ${this.threshold} times. Try a different approach: use "snapshot" to re-read the page, try different element numbers, or navigate to a different URL.`
    }

    return null
  }

  reset(): void {
    this.history = []
  }
}
```

- [ ] **Step 4: Integrate tracker into BrowserSession**

Add to `BrowserSession` class:

```typescript
  private actionTracker = new BrowserActionTracker(3)
```

In `execute` method, after successful action, add:

```typescript
      const warning = this.actionTracker.record(action, args, this.page?.url() || '')
      if (warning && result.success) {
        result.output = result.output + '\n\n⚠️ ' + warning
      }
```

In the `open` method, add:

```typescript
    this.actionTracker.reset()
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/browser-stuck-detection.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/modules/browser/session.ts tests/browser-stuck-detection.test.ts
git commit -m "feat: add browser stuck detection for repeated actions"
```

---

### Task 12: Final integration test + typecheck

**Files:**
- No new files

- [ ] **Step 1: Run full typecheck**

Run: `tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 3: Manual smoke test — open a page**

```bash
bun run mma "open https://example.com in the browser and tell me what's on the page"
```

Expected: Agent uses `browser(open, url)` → gets snapshot → reads content → responds

- [ ] **Step 4: Manual smoke test — click and type**

```bash
bun run mma "use the browser to search for 'Rust programming' on DuckDuckGo"
```

Expected: Agent opens duckduckgo.com → clicks search box → types query → clicks search button → reads results

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: browser integration fixes from smoke test"
```
