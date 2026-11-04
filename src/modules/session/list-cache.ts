// Кеш реестра сессий (INV-W3, спека 2026-11-04-webui-latency-design, C3).
//
// В `~/.mma/sessions` на порядок больше каталогов, чем сессий: без кеша каждый
// `listSessions` статит их все синхронно в event loop (~150 мс на 3 874
// каталога). Два кеша живут вместе и на одном TTL: список сессий и
// отсутствующие меты — оба отвечают на вопрос «что в каталоге».
import type { SessionMeta } from "./types";

/** TTL обоих кешей реестра. */
export const SESSIONS_LIST_TTL_MS = 1_000;

/** TTL-кеш списка сессий плюс кеш отсутствующих мет. */
export class SessionListCache {
  private items: SessionMeta[] | null = null;
  private at = Number.NEGATIVE_INFINITY;
  private missing = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = SESSIONS_LIST_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /** Закешированный список; `null` — окно истекло, пора пересканировать. */
  peek(now: number): SessionMeta[] | null {
    if (this.items === null || now - this.at >= this.ttlMs) return null;
    return this.items;
  }

  /** Запомнить свежий список (копию держит владелец). */
  remember(items: SessionMeta[], now: number): void {
    this.items = items;
    this.at = now;
  }

  /** Известно ли в пределах окна, что меты нет. */
  missingSince(id: string, now: number): boolean {
    const at = this.missing.get(id);
    return at !== undefined && now - at < this.ttlMs;
  }

  /** Мета отсутствует или битая — проверено в момент `now`. */
  markMissing(id: string, now: number): void {
    this.missing.set(id, now);
  }

  /** Мета записана через стор — отрицательный ответ устарел. */
  forget(id: string): void {
    this.missing.delete(id);
  }

  /** Сброс списка: запись или удаление меты. */
  invalidate(): void {
    this.items = null;
  }
}
