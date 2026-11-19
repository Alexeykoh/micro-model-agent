// Предполёт браузера: установлен ли Chromium.
//
// Раньше отсутствие Chromium выглядело как «No page open» — модель и
// пользователь не понимали, что нужно доставить браузер (аудит §3.3).
import { existsSync } from "fs";

/** Команда установки Chromium, которую видит пользователь. */
export const CHROMIUM_INSTALL_CMD = "bunx playwright install chromium";

/** Кэш результата: проверка дорогая, а браузер за сессию ставится один раз. */
let cached: boolean | undefined;

/** Тестовый шов: подмена результата проверки. */
let override: boolean | undefined;

/** Путь к исполняемому файлу Chromium (Playwright знает свою папку браузеров). */
export async function chromiumExecutablePath(): Promise<string | undefined> {
  try {
    const { chromium } = await import("playwright");
    return chromium.executablePath();
  } catch {
    return undefined;
  }
}

/**
 * Установлен ли Chromium. Ошибка (нет playwright, нет папки) — «не установлен».
 */
export async function isChromiumInstalled(): Promise<boolean> {
  if (override !== undefined) return override;
  if (cached !== undefined) return cached;
  const path = await chromiumExecutablePath();
  cached = Boolean(path) && existsSync(path as string);
  return cached;
}

/** Сброс кэша — для тестов. */
export function resetChromiumPreflight(): void {
  cached = undefined;
}

/**
 * Шов для тестов: подменяет результат проверки (как `agentFactory`/`criticOverride`
 * в ядре). `undefined` — снова реальная проверка.
 */
export function setChromiumInstalledOverride(value: boolean | undefined): void {
  override = value;
}

/** Chromium не установлен — действие объясняет, что доставить. */
export class BrowserUnavailableError extends Error {
  constructor() {
    super(
      `Browser unavailable: Chromium is not installed. Run \`${CHROMIUM_INSTALL_CMD}\` and try again.`,
    );
    this.name = "BrowserUnavailableError";
  }
}
