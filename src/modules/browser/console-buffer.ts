import type { ConsoleEntry, ConsoleType } from "./types";

const CONSOLE_MAX_LINE = 400;

/**
 * Bounded ring buffer of browser console entries.
 *
 * Extracted from `session.ts` so `driver.ts` and `bridge-client.ts` can share
 * it WITHOUT importing `session.ts` — that edge formed the two browser import
 * cycles fallow flagged (`driver ↔ session`, `driver → bridge-client → session`).
 */
export class ConsoleBuffer {
  private entries: ConsoleEntry[] = [];
  private maxEntries: number;

  constructor(maxEntries = 20) {
    this.maxEntries = maxEntries;
  }

  add(type: ConsoleType, text: string): void {
    const clean = String(text).replace(/\s+/g, " ").trim();
    if (!clean) return;
    const line = clean.length > CONSOLE_MAX_LINE ? `${clean.slice(0, CONSOLE_MAX_LINE)}…` : clean;
    this.entries.push({ type, text: line });
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
  }

  clear(): void {
    this.entries = [];
  }

  getAll(): ConsoleEntry[] {
    return [...this.entries];
  }

  get size(): number {
    return this.entries.length;
  }
}
