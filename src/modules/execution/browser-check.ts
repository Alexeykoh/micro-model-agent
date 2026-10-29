// `browser:`-проверка шага плана: runtime-сигнал для UI (D-15).
//
// Формат: `browser:<url>` (страница грузится без ошибок консоли) или
// `browser:<url>~<подстрока>` (плюс подстрока в видимом тексте/HTML).
// Один URL, без интерактива и скриншотов: проба открывает страницу, ждёт
// загрузку, читает консоль и закрывает браузер. Бюджет короткий (7 с), чтобы
// `verify` не висел на мёртвом дев-сервере.
//
// Это НЕ доказательство «всё работает», а отсечение класса «200, но пусто»:
// необработанный `TypeError` в рантайме даёт `pageerror`/`console.error`.
import type { ConsoleEntry } from "../browser/types";
import { DEFAULT_BROWSER_CONFIG } from "../browser/types";

/** Бюджет одной пробы: запуск + навигация + чтение DOM. */
export const BROWSER_CHECK_TIMEOUT_MS = 7000;
/** Пауза после `domcontentloaded`, чтобы поздние ошибки успели попасть в консоль. */
const BROWSER_SETTLE_MS = 300;
/** Таймаут закрытия: проба не имеет права держать процесс. */
const BROWSER_CLOSE_TIMEOUT_MS = 2000;

/**
 * Шум консоли, не означающий сломанную страницу: devtools-подсказки, шум
 * ResizeObserver и запрос favicon (его 404 ничего не говорит о рендере).
 */
const NOISE_PATTERNS = [
  /Download the React DevTools/i,
  /ResizeObserver loop (limit exceeded|completed)/i,
  /favicon\.ico/i,
];

/** Минимальный контракт страницы для пробы (Playwright-драйвер его реализует). */
export interface BrowserProbe {
  goto(url: string, timeoutMs: number): Promise<void>;
  /** Видимый текст (`document.body.innerText`). */
  visibleText(): Promise<string>;
  /** HTML документа (маркер может быть в разметке, а не только в тексте). */
  html(): Promise<string>;
  /** Записи консоли, накопленные с момента навигации. */
  consoleEntries(): ConsoleEntry[];
  close(): Promise<void>;
}

/** Инжектируемый лаунчер: тесты подменяют его, как `fetchImpl` у `http:`. */
export type BrowserProbeLauncher = () => Promise<BrowserProbe>;

export interface BrowserCheckResult {
  ok: boolean;
  /** Сколько значимых ошибок консоли (после фильтра шума). */
  consoleErrors: number;
  /** Найден ли маркер (undefined — маркер не задан). */
  markerFound?: boolean;
  /** Одна строка для модели: `ok · 0 console errors · marker found`. */
  line: string;
  /** Причина отказа (для сообщения об ошибке). */
  reason?: string;
}

/** Разбирает цель после `browser:` на url и необязательный маркер. */
export function parseBrowserTarget(target: string): { url: string; marker?: string } | null {
  const raw = target.trim();
  const sep = raw.indexOf("~");
  const url = (sep === -1 ? raw : raw.slice(0, sep)).trim();
  const marker = sep === -1 ? undefined : raw.slice(sep + 1).trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) return null;
  return { url, ...(marker ? { marker } : {}) };
}

class CheckTimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new CheckTimeoutError(`timeout ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNoise(text: string): boolean {
  return NOISE_PATTERNS.some((re) => re.test(text));
}

function significantErrors(entries: ConsoleEntry[]): ConsoleEntry[] {
  return entries.filter(
    (e) => (e.type === "error" || e.type === "pageerror") && !isNoise(e.text),
  );
}

function line(ok: boolean, errors: number, marker: string | undefined, found: boolean): string {
  const markerState = marker ? (found ? "found" : "not found") : "n/a";
  return `${ok ? "ok" : "failed"} · ${errors} console errors · marker ${markerState}`;
}

function summarize(
  text: string,
  html: string,
  entries: ConsoleEntry[],
  marker: string | undefined,
): BrowserCheckResult {
  const errors = significantErrors(entries);
  const markerFound = marker ? text.includes(marker) || html.includes(marker) : undefined;
  if (errors.length > 0) {
    return {
      ok: false,
      consoleErrors: errors.length,
      ...(markerFound === undefined ? {} : { markerFound }),
      line: line(false, errors.length, marker, Boolean(markerFound)),
      reason: `${errors.length} console error(s): ${errors[0].text}`.slice(0, 240),
    };
  }
  if (marker && !markerFound) {
    return {
      ok: false,
      consoleErrors: 0,
      markerFound: false,
      line: line(false, 0, marker, false),
      reason: `marker not found: ${marker}`,
    };
  }
  return {
    ok: true,
    consoleErrors: 0,
    ...(markerFound === undefined ? {} : { markerFound }),
    line: line(true, 0, marker, Boolean(markerFound)),
  };
}

/**
 * Реальный лаунчер: существующий браузерный модуль (предполёт Chromium +
 * драйвер). Playwright и Chromium грузятся динамически, поэтому юнит-тесты с
 * инжектированным лаунчером их не трогают.
 */
async function defaultLauncher(): Promise<BrowserProbe> {
  const { isChromiumInstalled, BrowserUnavailableError } = await import("../browser/preflight");
  if (!(await isChromiumInstalled())) throw new BrowserUnavailableError();
  const { createBrowserDriver } = await import("../browser/driver");
  const driver = await createBrowserDriver({
    ...DEFAULT_BROWSER_CONFIG,
    headless: true,
    navigationTimeout: BROWSER_CHECK_TIMEOUT_MS,
  });
  return {
    goto: (url, ms) => driver.goto(url, ms),
    visibleText: async () => {
      const value = await driver.evaluate("document.body ? document.body.innerText : ''");
      return typeof value === "string" ? value : "";
    },
    html: () => driver.content(),
    consoleEntries: () => driver.getConsole(),
    close: () => driver.close(),
  };
}

/**
 * Открывает URL в headless-браузере и проверяет отсутствие ошибок консоли
 * (плюс маркер). Не бросает: любая неудача — `ok:false` с причиной (INV-G4),
 * включая недоступный Chromium. Страница закрывается в `finally`.
 */
export async function runBrowserCheck(
  target: string,
  opts: { timeoutMs?: number; launcher?: BrowserProbeLauncher } = {},
): Promise<BrowserCheckResult> {
  const parsed = parseBrowserTarget(target);
  if (!parsed) {
    return {
      ok: false,
      consoleErrors: 0,
      line: line(false, 0, undefined, false),
      reason: "invalid url (expect http:// or https://)",
    };
  }

  const timeoutMs = opts.timeoutMs ?? BROWSER_CHECK_TIMEOUT_MS;
  const launch = opts.launcher ?? defaultLauncher;
  const startedAt = Date.now();
  const remaining = () => Math.max(1, timeoutMs - (Date.now() - startedAt));
  let probe: BrowserProbe | null = null;

  try {
    probe = await withTimeout(launch(), timeoutMs);
    await withTimeout(probe.goto(parsed.url, timeoutMs), timeoutMs);
    await sleep(Math.min(BROWSER_SETTLE_MS, remaining()));
    const [text, html] = await withTimeout(
      Promise.all([probe.visibleText(), probe.html()]),
      remaining(),
    );
    return summarize(text, html, probe.consoleEntries(), parsed.marker);
  } catch (err) {
    if (err instanceof CheckTimeoutError) {
      return {
        ok: false,
        consoleErrors: 0,
        line: line(false, 0, parsed.marker, false),
        reason: `timeout ${timeoutMs}ms`,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (/unavailable|chromium is not installed|executable doesn't exist/i.test(msg)) {
      return {
        ok: false,
        consoleErrors: 0,
        line: line(false, 0, parsed.marker, false),
        reason: `browser unavailable: ${msg}`.slice(0, 240),
      };
    }
    return {
      ok: false,
      consoleErrors: 0,
      line: line(false, 0, parsed.marker, false),
      reason: msg.slice(0, 240),
    };
  } finally {
    if (probe) {
      await withTimeout(probe.close(), BROWSER_CLOSE_TIMEOUT_MS).catch(() => {});
    }
  }
}
