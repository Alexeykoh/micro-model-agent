// Ленивый подъём usage-снимка с диска для сайдбара `mma web`.
// Вынесено из `state.ts` (правило 6): файл состояния уже на потолке.
import type { UsageSnapshot } from "../../../core/host-state";
import { loadSessionUsage } from "./session-usage";

/** Узкий вход: метрики сессий + менеджер (без импорта `WebUiState` — без цикла). */
export interface UsageCacheState {
  sessionManager?: {
    getActive?(): string | null;
    getSessionDirectory?(id: string): string;
  };
  sessionUsage: Record<string, UsageSnapshot>;
  activeSessionId?: string;
}

/** Сколько снимков usage держим в памяти (LRU по порядку вставки). */
export const SESSION_USAGE_CACHE_MAX = 50;

/**
 * Usage для сайдбара: метрики серверно-активной сессии (или явной `sessionId`
 * веб-вкладки). У сессии без ходов — undefined (сайдбар показывает прочерки),
 * а НЕ чужой last-turn. Снимок лениво поднимается с диска после reload.
 */
export function activeUsage(s: UsageCacheState, sessionId?: string): UsageSnapshot | undefined {
  try {
    const active = sessionId ?? s.sessionManager?.getActive?.() ?? s.activeSessionId ?? null;
    if (active) {
      if (s.sessionUsage[active]) return s.sessionUsage[active];
      // Reload/restart: in-memory карта пуста — поднимаем снимок с диска
      // (каталог сессии) и кэшируем, чтобы не читать файл на каждый полл.
      const dir = s.sessionManager?.getSessionDirectory?.(active);
      if (dir) {
        const persisted = loadSessionUsage(dir);
        if (persisted) {
          // Кэш usage ограничен: сессий за день открывается много (аудит §6.12).
          const keys = Object.keys(s.sessionUsage);
          if (keys.length >= SESSION_USAGE_CACHE_MAX) delete s.sessionUsage[keys[0]];
          s.sessionUsage[active] = persisted;
          return persisted;
        }
      }
    }
  } catch {
    /* fail-open: нет метрик */
  }
  return undefined;
}
