// Session slice of the shared frontend state: the sessions list, host snapshot,
// per-session run/queue flags and reasoning support. Owned by `session/**` +
// `app.js`; aliased on the composed `S` (`./index.js`).
import type { Dict } from "./types.js";

export interface SessionSlice {
  sessions: Dict[];
  host: Dict;
  busy: boolean;
  activeSessionId: string | null;
  runningSessionId: string | null;
  runningSessionIds: string[];
  /** Сессии с приостановленным ходом (SSE `state`, INV-P5). */
  pausedIds: string[];
  queued: Record<string, number>;
  /** Server ids of each session's FIFO, in order (for queue actions). */
  queuedIds: Record<string, string[]>;
  sessionsError: string | null;
  // biome-ignore lint/suspicious/noExplicitAny: opaque reasoning payload.
  reasoning: any;
  /**
   * Разрешённые возможности активной модели (`GET /api/models` → `capabilities`).
   * `null` — ещё не загружены/не поддерживаются сервером: чип скрыт, а не
   * показывает ложное `text-only`.
   */
  capabilities:
    | { vision?: boolean; video?: boolean; audio?: boolean; pdf?: boolean; tools?: boolean }
    | null;
}

export const session: SessionSlice = {
  sessions: [],
  host: {},
  busy: false,
  activeSessionId: null,
  runningSessionIds: [],
  runningSessionId: null,
  pausedIds: [],
  queued: {},
  queuedIds: {},
  sessionsError: null,
  reasoning: undefined,
  capabilities: null,
};

/**
 * Идёт ли ход АКТИВНОЙ сессии. Оконный хром (рельс, маскот, Trace) говорит
 * только о вкладке на экране: фоновая работа второй сессии — её бейдж в
 * полоске вкладок, а не «думаю» в свежем чате. Легаси-фолбэк (`busy` без
 * per-session id) относим к активной: иначе на старом сервере рельс молчит.
 */
export function activeTurnRunning(): boolean {
  const id = session.activeSessionId;
  if (!id) return false;
  const running = session.runningSessionIds || [];
  if (running.length) return running.includes(id);
  return !!session.busy;
}

/** Событие принадлежит активной вкладке (без `sessionId` — глобальное/легаси). */
export function ownsActiveSession(sessionId?: string | null): boolean {
  if (!sessionId) return true;
  return sessionId === session.activeSessionId;
}
