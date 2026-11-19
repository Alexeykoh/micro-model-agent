// Типы браузера: действия, элементы, консоль, снапшот, конфиг, дефолты.
/** Действия, доступные модели в браузере. */
export type BrowserAction =
  | "open"
  | "click"
  | "type"
  | "scroll"
  | "back"
  | "forward"
  | "screenshot"
  | "snapshot"
  | "close"
  | "wait";

/** Интерактивный элемент страницы из снапшота. */
export interface ElementEntry {
  index: number;
  tag: string;
  role: string;
  name: string;
  value?: string;
  href?: string;
  visible: boolean;
}

/** Тип записи консоли браузера. */
export type ConsoleType = "log" | "info" | "warning" | "error" | "debug" | "pageerror" | "network";

/** Запись консоли браузера. */
export interface ConsoleEntry {
  type: ConsoleType;
  text: string;
}

/** Сетевая ошибка страницы (упавший запрос). */
export interface NetworkErrorEntry {
  method: string;
  url: string;
  error: string;
}

/** Полный снапшот страницы для модели. */
export interface PageSnapshot {
  url: string;
  title: string;
  elements: ElementEntry[];
  content: string;
  console: ConsoleEntry[];
  networkErrors: NetworkErrorEntry[];
  truncated: boolean;
}

/** Состояние сессии браузера. */
export interface BrowserState {
  isOpen: boolean;
  url: string | null;
  title: string | null;
  elementCount: number;
}

import type { NetworkSecurityConfig } from "../../config/types";

/** Конфиг браузера: headless, лимиты, вьюпорт, куки, таймауты. */
export interface BrowserConfig {
  headless: boolean;
  maxElements: number;
  maxContentChars: number;
  maxConsoleEntries: number;
  maxConsoleLineChars: number;
  screenshotMaxWidth: number;
  cookieDir: string;
  viewportWidth: number;
  viewportHeight: number;
  navigationTimeout: number;
  /**
   * Сетевая политика браузера (SSRF): без неё приватные адреса и
   * metadata-эндпоинты не открываются (аудит §2.3).
   */
  networkSecurity?: NetworkSecurityConfig;
}

/** Результат действия: успех, текстовый вывод, опциональный скриншот. */
export interface ActionResult {
  success: boolean;
  output: string;
  screenshot?: Buffer;
}

/** Дефолтный конфиг браузера. */
export const DEFAULT_BROWSER_CONFIG: BrowserConfig = {
  headless: true,
  maxElements: 30,
  maxContentChars: 2500,
  maxConsoleEntries: 40,
  maxConsoleLineChars: 400,
  screenshotMaxWidth: 1280,
  cookieDir: "",
  viewportWidth: 1280,
  viewportHeight: 720,
  navigationTimeout: 15000,
};
