import type { ToolDefinition, ToolContext, ToolResult } from './types'
import { BrowserSession } from '../modules/browser/session'
import { DEFAULT_BROWSER_CONFIG } from '../modules/browser/types'
import { t } from '../i18n/index'
import { join } from 'path'

let session: BrowserSession | null = null

function getSession(ctx: ToolContext): BrowserSession {
  if (!session) {
    const cookieDir = join(ctx.baseDir, '.mma', 'browser')
    session = new BrowserSession({
      ...DEFAULT_BROWSER_CONFIG,
      headless: ctx.config.browser?.headless ?? true,
      maxElements: ctx.config.browser?.maxElements ?? 30,
      maxContentChars: ctx.config.browser?.maxContentChars ?? 2500,
      maxConsoleEntries: ctx.config.browser?.maxConsoleEntries ?? 40,
      maxConsoleLineChars: ctx.config.browser?.maxConsoleLineChars ?? 400,
      navigationTimeout: ctx.config.browser?.navigationTimeout ?? 15000,
      viewportWidth: ctx.config.browser?.viewportWidth ?? 1280,
      viewportHeight: ctx.config.browser?.viewportHeight ?? 720,
      cookieDir,
    })
  }
  return session
}

export function formatScreenshotForTextModel(snapshot: string): string {
  return `${t('tool.screenshot_unavailable')}\n\n${snapshot}`
}

export function formatScreenshotResult(snapshot: string, screenshot: Buffer, supportsVision: boolean): string {
  if (!supportsVision) {
    return formatScreenshotForTextModel(snapshot)
  }
  const base64 = screenshot.toString('base64')
  return `${snapshot}\n\n[Screenshot: data:image/png;base64,${base64}]`
}

export function createBrowserTool(): ToolDefinition {
  return {
    name: 'browser',
    tags: ['browser', 'vision'],
    description: [
      'Control a headless browser. Navigate pages, click elements, type text, scroll, take screenshots.',
      'Runs a real browser with JavaScript enabled — use it for JS-rendered sites (weather, dashboards, SPAs) where web_fetch/web_browse return empty content.',
      'Do NOT use it for search queries: search engines (Google, Yandex, Bing) block headless browsers with CAPTCHA/429/redirect pages — use the web_search tool for searching.',
      'Each snapshot returns: a numbered list of interactive elements, the visible page text (Content section), browser console messages, and network errors.',
      'Use the Content section to understand what the page says; use element numbers as targets for click/type.',
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
        return { success: false, output: t('tool.action_required') }
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
  }
}

export function closeBrowserSession(): void {
  if (session) {
    session.close().catch(() => {})
    session = null
  }
}
