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
    waitUntil: 'domcontentloaded',
    timeout: NAV_TIMEOUT_MS,
  });

  // Ждём появления body
  await page.waitForSelector('body', { timeout: 5000 }).catch(() => {});

  // Ждём networkidle для AJAX-страниц (макс 8 сек)
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

  // Доп. ожидание для тяжёлых JS-страниц
  await page.waitForTimeout(2000);

  // Универсальный автоскролл: скроллим пока DOM стабилизируется
  // (нет новых элементов после скролла) или до лимита (8 скроллов).
  // Покрывает: lazy loading, infinite scroll, AJAX-каталоги.
  try {
    let prevCount = await page.evaluate(() => document.querySelectorAll('*').length);
    const maxScrolls = 8;
    let scrollsDone = 0;

    for (let i = 0; i < maxScrolls; i++) {
      // Скроллим вниз на высоту вьюпорта
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      scrollsDone++;

      // Ждём загрузки контента (networkidle + фиксированная пауза)
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1500);

      // Проверяем стабилизацию DOM
      const newCount = await page.evaluate(() => document.querySelectorAll('*').length);
      if (newCount === prevCount) {
        // DOM стабилизировался — пробуем ещё раз для надёжности
        await page.evaluate(() => window.scrollBy(0, window.innerHeight));
        await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(1000);
        const finalCount = await page.evaluate(() => document.querySelectorAll('*').length);
        if (finalCount === prevCount) break; // Стабильно — выходим
      }
      prevCount = newCount;
    }

    // Вернуться наверх
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);
  } catch { /* ignore — scroll is best-effort */ }

  const status = response?.status() ?? 0;
  const title = await page.title();
  const finalUrl = page.url();

  // Краткая сводка страницы — ссылки + ключевые классы
  let summary = '';
  try {
    const info = await page.evaluate(() => {
      // Ссылки (до 10)
      const links = Array.from(document.querySelectorAll('a[href]'))
        .filter((a): a is HTMLAnchorElement => a instanceof HTMLAnchorElement)
        .filter(a => !a.href.startsWith('javascript:') && !a.href.startsWith('#'))
        .slice(0, 10)
        .map(a => ({
          text: (a.textContent ?? '').trim().substring(0, 60),
          href: a.href,
          parentClass: a.closest('div[class], li[class], article[class], section[class]')?.className?.substring(0, 40) ?? '',
        }));

      // Ключевые классы (уникальные, содержат слова-маркеры)
      const allElements = document.querySelectorAll('*');
      const classSet = new Set<string>();
      for (const el of allElements) {
        for (const cls of el.classList) {
          if (cls.length > 2 && cls.length < 50) classSet.add(cls);
        }
      }
      const classes = Array.from(classSet).sort();

      return { links, classes, totalElements: allElements.length };
    }, );

    if (info.links.length > 0 || info.classes.length > 0) {
      summary = `\n\nPage summary (${info.totalElements} elements):`;
      if (info.links.length > 0) {
        summary += `\nLinks (${info.links.length} shown):`;
        for (const link of info.links.slice(0, 8)) {
          summary += `\n  "${link.text || '(no text)'}" → ${link.href}`;
          if (link.parentClass) summary += ` [${link.parentClass}]`;
        }
      }
      if (info.classes.length > 0) {
        summary += `\nKey classes: ${info.classes.slice(0, 15).join(', ')}${info.classes.length > 15 ? ` (+${info.classes.length - 15} more)` : ''}`;
      }
      summary += `\nUse discover for full structure, or extract to get content.`;
    }
  } catch { /* ignore — summary is optional */ }

  return `Navigated to: ${finalUrl}\nTitle: ${title}\nStatus: ${status}${summary}`;
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
      return `Error: could not extract from "${selector}": ${e.message}. Hint: extract the full page first (no selector) to see the actual structure, then choose the right selector.`;
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
  const condition = String(args.condition ?? '').trim();
  const timeout = Number(args.timeout) || 5000;

  if (condition) {
    try {
      await page.waitForFunction(condition, { timeout });
      return `Condition "${condition}" met`;
    } catch {
      return `Timeout: condition "${condition}" not met within ${timeout}ms`;
    }
  } else if (selector) {
    try {
      await page.waitForSelector(selector, { state: 'visible', timeout });
      return `Element "${selector}" appeared`;
    } catch {
      return `Timeout: element "${selector}" not found within ${timeout}ms. Hint: extract the full page first (no selector) to see the actual structure.`;
    }
  } else {
    await page.waitForTimeout(timeout);
    return `Waited ${timeout}ms`;
  }
}

async function actionDiscover(page: import('playwright').Page, _args: Record<string, unknown>): Promise<string> {
  const result = await page.evaluate(() => {
    // Все уникальные CSS-классы на странице
    const allElements = document.querySelectorAll('*');
    const classSet = new Set<string>();
    for (const el of allElements) {
      for (const cls of el.classList) {
        if (cls.length > 1 && cls.length < 60) classSet.add(cls);
      }
    }
    const classes = Array.from(classSet).sort();

    // Все ссылки (до 50)
    const links = Array.from(document.querySelectorAll('a[href]'))
      .filter((a): a is HTMLAnchorElement => a instanceof HTMLAnchorElement)
      .filter(a => !a.href.startsWith('javascript:') && !a.href.startsWith('#'))
      .slice(0, 50)
      .map(a => ({
        text: (a.textContent ?? '').trim().substring(0, 100),
        href: a.href,
        parentClass: a.closest('div[class], li[class], article[class], section[class]')?.className ?? '',
      }));

    return { classes, links };
  });

  let output = `=== DISCOVER: ${result.classes.length} unique classes, ${result.links.length} links ===\n\n`;

  if (result.links.length > 0) {
    output += '--- Links (first 20) ---\n';
    for (const link of result.links.slice(0, 20)) {
      output += `  "${link.text || '(no text)'}" → ${link.href}\n  parent: ${link.parentClass}\n`;
    }
  }

  output += `\n--- All classes (${result.classes.length}) ---\n`;
  output += result.classes.join(', ');

  return output;
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
    // Двойной eval() в page.evaluate():
    // 1. Пробуем eval(code) напрямую — работает для выражений (document.title)
    // 2. Если SyntaxError из-за return — оборачиваем в IIFE: (function(){ code })()
    // Это позволяет модели использовать И выражения, И return-стейтменты.
    const result = await page.evaluate((script) => {
      // eslint-disable-next-line no-eval
      let raw;
      try {
        raw = eval(script);
      } catch (e: any) {
        if (e instanceof SyntaxError && /\breturn\b/.test(script)) {
          // Оборачиваем в IIFE чтобы return работал
          raw = eval('(function(){ ' + script + ' })()');
        } else {
          throw e;
        }
      }

      // Автоматически конвертируем NodeList/HTMLCollection в Array для JSON
      if (raw instanceof NodeList || raw instanceof HTMLCollection) {
        return Array.from(raw);
      }
      return raw;
    }, code);

    if (result === undefined) return '(undefined)';
    if (result === null) return '(null)';
    if (typeof result === 'object') return JSON.stringify(result, null, 2);
    return String(result);
  } catch (e: any) {
    const msg = e.message ?? String(e);
    // Подсказка при типичных ошибках
    if (msg.includes('slice is not a function')) {
      return `Error: ${msg}\nHint: use Array.from(document.querySelectorAll(...)).slice(...) instead of document.querySelectorAll(...).slice(...)`;
    }
    if (msg.includes('SyntaxError') && msg.includes('return')) {
      return `Error: ${msg}\nHint: "return" works but code must be valid JS inside a function body. Check for syntax errors in your code.\n  Example: return document.title\n  Example: return Array.from(document.querySelectorAll('a')).map(a => a.href)`;
    }
    if (msg.includes('SyntaxError')) {
      return `Error: JS syntax error — ${msg}\nHint: check parentheses, quotes, and semicolons. evaluate runs JS in browser context.`;
    }
    // Ошибки "null/undefined" — скорее всего селектор не найден
    if (msg.includes('Cannot read propert') || msg.includes('is null') || msg.includes('is undefined')
        || msg.includes('null') || msg.includes('undefined')) {
      return `Error: ${msg}\nHint: A selector likely returned null. Use web_browse(action:"discover") to find real CSS selectors on this page, then retry with the correct selector.`;
    }
    return `Error: evaluate failed: ${msg}`;
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
          enum: ['navigate', 'click', 'type', 'extract', 'screenshot', 'scroll', 'wait', 'get_links', 'evaluate', 'discover', 'close'],
          description: 'Action to perform on the page',
        },
        url: { type: 'string', description: 'URL to navigate to (for navigate action)' },
        selector: { type: 'string', description: 'CSS selector or text to target an element' },
        value: { type: 'string', description: 'Value to type, or JS code to evaluate' },
        direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction (default: down)' },
        format: { type: 'string', enum: ['text', 'html'], description: 'Extract format (default: text)' },
        maxChars: { type: 'number', description: 'Max characters to extract (default: 10000)' },
        timeout: { type: 'number', description: 'Timeout in ms for wait action (default: 5000)' },
        condition: { type: 'string', description: 'JS expression to wait for (e.g. "document.querySelectorAll(\\\'.item\\\').length > 0") — for wait action only' },
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
        case 'discover':  result = await actionDiscover(state.page, args); break;
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
