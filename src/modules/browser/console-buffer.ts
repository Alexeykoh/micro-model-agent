// Ограниченный кольцевой буфер записей консоли браузера.
import type { ConsoleEntry, ConsoleType } from "./types";

const CONSOLE_MAX_LINE = 400;

/**
 * Ограниченный буфер записей консоли браузера.
 * Вынесен из `session.ts`, чтобы `driver.ts` и `bridge-client.ts` делили его
 * БЕЗ импорта `session.ts` — это ребро давало два цикла импортов
 * (`driver ↔ session`, `driver → bridge-client → session`).
 */
export class ConsoleBuffer {
  private entries: ConsoleEntry[] = [];
  private maxEntries: number;

  constructor(maxEntries = 20) {
    this.maxEntries = maxEntries;
  }

  /** Добавить запись; пустые отбрасываются, длинные строки режутся. */
  add(type: ConsoleType, text: string): void {
    const clean = String(text).replace(/\s+/g, " ").trim();
    if (!clean) return;
    const line = clean.length > CONSOLE_MAX_LINE ? `${clean.slice(0, CONSOLE_MAX_LINE)}…` : clean;
    this.entries.push({ type, text: line });
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
  }

  /** Очистить буфер. */
  clear(): void {
    this.entries = [];
  }

  /** Все записи копией. */
  getAll(): ConsoleEntry[] {
    return [...this.entries];
  }

  /** Текущее число записей. */
  get size(): number {
    return this.entries.length;
  }
}
