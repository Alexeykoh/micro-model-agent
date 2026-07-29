import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import type { BrowserConfig, BrowserState, ActionResult } from './types'
import { extractInteractiveElements, formatSnapshot } from './snapshot'
import { buildClickScript, buildTypeScript, buildScrollScript, buildIndexInjectionScript } from './actions'
import { CookieStore, type StoredCookie } from './cookie-store'
import { t } from '../../i18n/index'

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
      return t('browser.repeated_action', { action, threshold: this.threshold })
    }

    return null
  }

  reset(): void {
    this.history = []
  }
}

export class BrowserSession {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private page: Page | null = null
  private config: BrowserConfig
  private cookieStore: CookieStore
  private state: BrowserState = { isOpen: false, url: null, title: null, elementCount: 0 }
  private actionTracker = new BrowserActionTracker(3)

  constructor(config: BrowserConfig) {
    this.config = config
    this.cookieStore = new CookieStore(config.cookieDir)
  }

  getState(): BrowserState {
    return { ...this.state }
  }

  async execute(action: string, args: Record<string, unknown>): Promise<ActionResult> {
    try {
      let result: ActionResult
      switch (action) {
        case 'open': result = await this.open(String(args.url || '')); break
        case 'click': result = await this.click(Number(args.target)); break
        case 'type': result = await this.type(Number(args.target), String(args.text || '')); break
        case 'scroll': result = await this.scroll(String(args.direction || 'down')); break
        case 'back': result = await this.back(); break
        case 'forward': result = await this.forward(); break
        case 'screenshot': result = await this.screenshot(); break
        case 'snapshot': result = await this.snapshot(); break
        case 'close': result = await this.close(); break
        case 'wait': result = await this.wait(Number(args.ms || 1000)); break
        default: return { success: false, output: t('browser.unknown_action', { action }) }
      }

      if (action !== 'open') {
        const warning = this.actionTracker.record(action, args, this.page?.url() || '')
        if (warning && result.success) {
          result.output = result.output + '\n\n⚠️ ' + warning
        }
      }

      return result
    } catch (err: any) {
      return { success: false, output: t('browser.error', { message: err.message }) }
    }
  }

  private async ensurePage(): Promise<ActionResult | null> {
    if (!this.page) {
      return { success: false, output: t('browser.no_page') }
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
    if (!url) return { success: false, output: t('browser.url_required') }

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url
    }

    await this.launch()
    if (!this.page) return { success: false, output: t('browser.create_page_failed') }

    this.actionTracker.reset()

    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.config.navigationTimeout })
    } catch (err: any) {
      return { success: false, output: t('browser.nav_failed', { message: err.message }) }
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
      return { success: false, output: t('browser.invalid_target') }
    }

    try {
      const script = buildClickScript(target)
      await this.page.evaluate(script)
      await this.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})
      await new Promise(r => setTimeout(r, 500))
      const snapshot = await this.takeSnapshot()
      await this.saveCookies()
      return { success: true, output: snapshot }
    } catch (err: any) {
      return { success: false, output: t('browser.click_failed', { message: err.message }) }
    }
  }

  private async type(target: number, text: string): Promise<ActionResult> {
    const err = await this.ensurePage()
    if (err) return err
    if (!this.page) return { success: false, output: 'No page' }

    if (!target || target < 1) {
      return { success: false, output: t('browser.invalid_target_short') }
    }
    if (!text) {
      return { success: false, output: t('browser.text_required') }
    }

    try {
      const script = buildTypeScript(target, text)
      await this.page.evaluate(script)
      const snapshot = await this.takeSnapshot()
      return { success: true, output: snapshot }
    } catch (err: any) {
      return { success: false, output: t('browser.type_failed', { message: err.message }) }
    }
  }

  private async scroll(direction: string): Promise<ActionResult> {
    const err = await this.ensurePage()
    if (err) return err
    if (!this.page) return { success: false, output: 'No page' }

    const dir = direction as 'up' | 'down' | 'top' | 'bottom'
    if (!['up', 'down', 'top', 'bottom'].includes(dir)) {
      return { success: false, output: t('browser.direction_invalid') }
    }

    try {
      await this.page.evaluate(buildScrollScript(dir))
      await new Promise(r => setTimeout(r, 300))
      const snapshot = await this.takeSnapshot()
      return { success: true, output: snapshot }
    } catch (err: any) {
      return { success: false, output: t('browser.scroll_failed', { message: err.message }) }
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
    return { success: true, output: t('browser.closed') }
  }
}
