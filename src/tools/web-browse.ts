import type { ToolDefinition } from './registry.js';
import type { ToolHandler } from './types.js';
import { logInfo, logError } from '../logger.js';

/**
 * Интерактивный инструмент для работы с веб-страницами через headless-браузер.
 *
 * Поддерживает 9 actions: navigate, click, type, extract, screenshot,
 * scroll, wait, get_links, evaluate.
 *
 * Сессия браузера stateful: navigate открывает страницу,
 * последующие action'ы работают с ней.
 *
 * @module tools/web-browse
 */

// ─── Browser Session ─────────────────────────────────────

/** Тип для Playwright (ленивый импорт) */
let playwrightModule: typeof import('playwright') | null = null;

async function getPlaywright() {
  if (!playwrightModule) {
    playwrightModule = await import('playwright');
  }
  return playwrightModule;
}

/** Состояние браузерной сессии */
interface BrowserState {
  browser: import('playwright').Browser | null;
  context: import('playwright').BrowserContext | null;
  page: import('playwright').Page | null;
  lastActivity: number;
}

const state: BrowserState = {
  browser: null,
  context: null,
  page: null,
  lastActivity: 0,
};

/** Таймаут неактивности (5 минут) */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** Таймаут навигации */
const NAV_TIMEOUT_MS = 30_000;

/** Инициализация браузера (лениво) */
async function ensureBrowser(): Promise<import('playwright').Page> {
  // Проверяем есть ли активная сессия
  if (state.page && !state.page.isClosed()) {
    state.lastActivity = Date.now();
    return state.page;
  }

  // Закрываем старые ресурсы
  await closeBrowser();

  const pw = await getPlaywright();
  state.browser = await pw.chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });
  state.context = await state.browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 },
  });
  state.page = await state.context.newPage();
  state.lastActivity = Date.now();

  logInfo('BROWSER', 'Headless browser launched');
  return state.page;
}

/** Закрытие браузера */
async function closeBrowser(): Promise<void> {
  try {
    if (state.page && !state.page.isClosed()) await state.page.close();
    if (state.context) await state.context.close();
    if (state.browser) await state.browser.close();
  } catch (e: any) {
    logError('BROWSER', `close error: ${e.message}`);
  }
  state.browser = null;
  state.context = null;
  state.page = null;
}

/** Проверка и закрытие при простое */
async function checkIdle(): Promise<void> {
  if (state.page && Date.now() - state.lastActivity > IDLE_TIMEOUT_MS) {
    logInfo('BROWSER', 'Idle timeout, closing browser');
    await closeBrowser();
  }
}

// ─── Actions ─────────────────────────────────────────────

async function actionNavigate(page: import('playwright').Page, args: Record<string, unknown>): Promise<string> {
  const url = String(args.url ?? '').trim();
  if (!url) return 'Error: url is required for navigate';
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return 'Error: URL must start with http:// or https://';
  }

  const response = await page.goto(url, {
    waitUntil: 'networkidle',
    timeout: NAV_TIMEOUT_MS,
  });

  const status = response?.status() ?? 0;
  const title = await page.title();
  const finalUrl = page.url();

  return `Navigated to: ${finalUrl}\nTitle: ${title}\nStatus: ${status}`;
}

async function actionClick(page: import('playwright').Page, args: Record<string, unknown>): Promise<string> {
  const selector = String(args.selector ?? '').trim();
  if (!selector) return 'Error: selector is required for click';

  // Пробуем CSS-селектор, затем текст
  try {
    await page.click(selector, { timeout: 10_000 });
  } catch {
    // Если CSS-селектор не сработал, пробуем getByText
    try {
      await page.getByText(selector, { exact: false }).first().click({ timeout: 10_000 });
    } catch (e: any) {
      return `Error: could not click "${selector}": ${e.message}`;
    }
  }

  // Ждём стабилизации после клика
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  return `Clicked: ${selector}`;
}

async function actionType(page: import('playwright').Page, args: Record<string, unknown>): Promise<string> {
  const selector = String(args.selector ?? '').trim();
  const value = String(args.value ?? '');
  if (!selector) return 'Error: selector is required for type';

  try {
    await page.fill(selector, value, { timeout: 10_000 });
  } catch {
    // Fallback: кликаем и печатаем
    try {
      await page.click(selector, { timeout: 5_000 });
      await page.keyboard.type(value, { delay: 30 });
    } catch (e: any) {
      return `Error: could not type into "${selector}": ${e.message}`;
    }
  }

  return `Typed "${value}" into ${selector}`;
}

async function actionExtract(page: import('playwright').Page, args: Record<string, unknown>): Promise<string> {
  const selector = String(args.selector ?? '').trim();
  const format = String(args.format ?? 'text');
  const maxChars = Number(args.maxChars) || 10_000;

  let content: string;

  if (selector) {
    // Извлечение из конкретного элемента
    try {
      if (format === 'html') {
        content = await page.innerHTML(selector, { timeout: 10_000 });
      } else {
        content = await page.textContent(selector, { timeout: 10_000 }) ?? '';
      }
    } catch (e: any) {
      return `Error: could not extract from "${selector}": ${e.message}`;
    }
  } else {
    // Извлечение всей страницы
    if (format === 'html') {
      content = await page.content();
    } else {
      content = await page.evaluate(() => document.body?.innerText ?? '');
    }
  }

  // Очистка
  content = content
    .replace(/\t/g, ' ')
    .replace(/[ ]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (content.length > maxChars) {
    content = content.slice(0, maxChars) + `\n... (truncated, ${content.length} total chars)`;
  }

  return content || '(empty)';
}

async function actionScreenshot(page: import('playwright').Page, args: Record<string, unknown>): Promise<string> {
  const selector = String(args.selector ?? '').trim();

  let buffer: Buffer;
  if (selector) {
    try {
      const element = await page.$(selector);
      if (!element) return `Error: element "${selector}" not found`;
      buffer = await element.screenshot({ type: 'png' }) as Buffer;
    } catch (e: any) {
      return `Error: screenshot of "${selector}" failed: ${e.message}`;
    }
  } else {
    buffer = await page.screenshot({ type: 'png', fullPage: false }) as Buffer;
  }

  const base64 = buffer.toString('base64');
  const url = page.url();
  const title = await page.title();

  return `Screenshot of: ${url}\nTitle: ${title}\nSize: ${buffer.length} bytes\nFormat: PNG\n\nbase64:${base64}`;
}

async function actionScroll(page: import('playwright').Page, args: Record<string, unknown>): Promise<string> {
  const direction = String(args.direction ?? 'down');

  const scrolled = await page.evaluate((dir) => {
    const amount = dir === 'up' ? -window.innerHeight : window.innerHeight;
    window.scrollBy(0, amount);
    return {
      scrollTop: window.scrollY,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: window.innerHeight,
    };
  }, direction);

  const atTop = scrolled.scrollTop <= 0;
  const atBottom = scrolled.scrollTop + scrolled.clientHeight >= scrolled.scrollHeight - 10;

  let status = `Scrolled ${direction}. Position: ${scrolled.scrollTop}px`;
  if (atTop && direction === 'up') status += ' (at top)';
  if (atBottom && direction === 'down') status += ' (at bottom)';

  return status;
}

async function actionWait(page: import('playwright').Page, args: Record<string, unknown>): Promise<string> {
  const selector = String(args.selector ?? '').trim();
  const timeout = Number(args.timeout) || 5000;

  if (selector) {
    try {
      await page.waitForSelector(selector, { state: 'visible', timeout });
      return `Element "${selector}" appeared`;
    } catch {
      return `Timeout: element "${selector}" not found within ${timeout}ms`;
    }
  } else {
    await page.waitForTimeout(timeout);
    return `Waited ${timeout}ms`;
  }
}

async function actionGetLinks(page: import('playwright').Page, _args: Record<string, unknown>): Promise<string> {
  const links = await page.$$eval('a[href]', (anchors) =>
    anchors.map((a) => ({
      text: (a.textContent ?? '').trim().slice(0, 100),
      href: a.getAttribute('href') ?? '',
    })).filter((l) => l.href && !l.href.startsWith('#') && !l.href.startsWith('javascript:'))
  );

  if (links.length === 0) return 'No links found on page.';

  const maxLinks = 50;
  let output = `Found ${links.length} links:\n\n`;
  for (let i = 0; i < Math.min(links.length, maxLinks); i++) {
    const l = links[i];
    output += `${i + 1}. ${l.text || '(no text)'}\n   ${l.href}\n`;
  }
  if (links.length > maxLinks) {
    output += `\n... and ${links.length - maxLinks} more`;
  }

  return output.trim();
}

async function actionEvaluate(page: import('playwright').Page, args: Record<string, unknown>): Promise<string> {
  const code = String(args.value ?? args.code ?? '').trim();
  if (!code) return 'Error: value (JS code) is required for evaluate';

  try {
    const result = await page.evaluate((script) => {
      // eslint-disable-next-line no-eval
      return eval(script);
    }, code);

    if (result === undefined) return '(undefined)';
    if (result === null) return '(null)';
    if (typeof result === 'object') return JSON.stringify(result, null, 2);
    return String(result);
  } catch (e: any) {
    return `Error: evaluate failed: ${e.message}`;
  }
}

// ─── Tool Definition ─────────────────────────────────────

export const webBrowseDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'web_browse',
    description: 'Interact with web pages using a headless browser. Navigate, click, type, scroll, extract text/HTML, take screenshots, and execute JavaScript on pages.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['navigate', 'click', 'type', 'extract', 'screenshot', 'scroll', 'wait', 'get_links', 'evaluate', 'close'],
          description: 'Action to perform on the page',
        },
        url: { type: 'string', description: 'URL to navigate to (for navigate action)' },
        selector: { type: 'string', description: 'CSS selector or text to target an element' },
        value: { type: 'string', description: 'Value to type, or JS code to evaluate' },
        direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction (default: down)' },
        format: { type: 'string', enum: ['text', 'html'], description: 'Extract format (default: text)' },
        maxChars: { type: 'number', description: 'Max characters to extract (default: 10000)' },
        timeout: { type: 'number', description: 'Timeout in ms for wait action (default: 5000)' },
      },
      required: ['action'],
    },
  },
};

// ─── Handler ─────────────────────────────────────────────

export const webBrowseHandler: ToolHandler = {
  name: 'web_browse',
  definition: webBrowseDefinition,
  async execute(args) {
    const action = String(args.action ?? '').trim();
    if (!action) {
      return { stdout: '', stderr: 'action is required', exitCode: 1, truncated: false };
    }

    try {
      // Проверка простой сессии перед каждым action'ом
      await checkIdle();

      // Close action
      if (action === 'close') {
        await closeBrowser();
        return { stdout: 'Browser closed.', stderr: '', exitCode: 0, truncated: false };
      }

      // Navigate не требует существующей страницы
      if (action === 'navigate') {
        // Валидация URL до запуска браузера
        const url = String(args.url ?? '').trim();
        if (!url) {
          return { stdout: '', stderr: 'url is required for navigate', exitCode: 1, truncated: false };
        }
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          return { stdout: '', stderr: 'URL must start with http:// or https://', exitCode: 1, truncated: false };
        }
        const page = await ensureBrowser();
        const result = await actionNavigate(page, args);
        return { stdout: result, stderr: '', exitCode: 0, truncated: false };
      }

      // Все остальные action'ы требуют активную страницу
      if (!state.page || state.page.isClosed()) {
        return {
          stdout: '',
          stderr: 'No active page. Use navigate action first.',
          exitCode: 1,
          truncated: false,
        };
      }

      let result: string;
      switch (action) {
        case 'click':     result = await actionClick(state.page, args); break;
        case 'type':      result = await actionType(state.page, args); break;
        case 'extract':   result = await actionExtract(state.page, args); break;
        case 'screenshot': result = await actionScreenshot(state.page, args); break;
        case 'scroll':    result = await actionScroll(state.page, args); break;
        case 'wait':      result = await actionWait(state.page, args); break;
        case 'get_links': result = await actionGetLinks(state.page, args); break;
        case 'evaluate':  result = await actionEvaluate(state.page, args); break;
        default:
          return { stdout: '', stderr: `Unknown action: ${action}`, exitCode: 1, truncated: false };
      }

      state.lastActivity = Date.now();
      const exitCode = result.startsWith('Error') || result.startsWith('Timeout') ? 1 : 0;
      return { stdout: result, stderr: '', exitCode, truncated: false };
    } catch (e: any) {
      logError('BROWSER', `${action} error: ${e.message}`);
      return { stdout: '', stderr: `Browser error: ${e.message}`, exitCode: 1, truncated: false };
    }
  },
};
