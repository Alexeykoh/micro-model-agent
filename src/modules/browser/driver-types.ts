// Контракт драйвера браузера и конфиг запуска (без циклов импортов).
import type { ConsoleEntry, NetworkErrorEntry } from "./types";
import type { StoredCookie } from "./cookie-store";

/** Явный путь/канал браузера из окружения. */
export interface BrowserLaunchOverrides {
  executablePath?: string;
  channel?: string;
}

/** Параметры запуска: headless, вьюпорт, таймаут, оверрайды. */
export interface LaunchConfig {
  headless: boolean;
  viewport: { width: number; height: number };
  timeoutMs: number;
  overrides?: BrowserLaunchOverrides;
}

/**
 * Контракт драйвера, общий для Playwright, node-моста и сессии.
 * Живёт в отдельном модуле, чтобы `bridge-client.ts` не импортил `driver.ts`
 * (который динамически импортит его) — это ребро давало цикл.
 */
export interface BrowserDriver {
  launch(cfg: LaunchConfig): Promise<void>;
  goto(url: string, timeoutMs: number): Promise<void>;
  evaluate(js: string): Promise<unknown>;
  content(): Promise<string>;
  title(): Promise<string>;
  url(): string;
  waitForLoad(timeoutMs: number): Promise<void>;
  screenshot(): Promise<Buffer>;
  cookies(): Promise<StoredCookie[]>;
  addCookies(cookies: StoredCookie[]): Promise<void>;
  goBack(timeoutMs: number): Promise<void>;
  goForward(timeoutMs: number): Promise<void>;
  resetEventLog(): void;
  getConsole(): ConsoleEntry[];
  getNetworkErrors(): NetworkErrorEntry[];
  close(): Promise<void>;
  dispose(): void;
}
