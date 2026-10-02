// Per-session статус слотов пула: счётчики, busy-агрегаты, резервы.
// Вынесено из `state.ts` (правило #1: ≤300 строк/файл). Сам `WebUiState`
// (типы, создание, broadcast) остаётся в `state.ts`.
import type { WebUiState } from "../state";

/** Счётчики очереди по сессиям (для бейджей вкладок; legacy-слот мимо). */
export function queuedCounts(s: WebUiState): Record<string, number> {
  return s.pool.queuedCounts();
}

/** Занята ли сессия: бежит или стоит в очереди. */
export function isSessionBusy(s: WebUiState, id: string): boolean {
  return s.pool.isBusy(id) || (s.pool.queuedCounts()[id] ?? 0) > 0;
}

/**
 * Per-session статус для SSE `state` и `GET /api/state`: глобальные
 * `busy/queueLen` (совместимость) + `runningSessionIds` и счётчики `queued`
 * по сессиям для бейджей вкладок (`runningSessionId` — первый, legacy).
 */
export function sessionStatus(s: WebUiState): {
  busy: boolean;
  queueLen: number;
  runningSessionId: string | null;
  runningSessionIds: string[];
  queued: Record<string, number>;
} {
  const running = s.pool.busyIds();
  return {
    busy: s.busy,
    queueLen: s.pool.totalQueued(),
    runningSessionId: running[0] ?? null,
    runningSessionIds: running,
    queued: s.pool.queuedCounts(),
  };
}

/** Пересчёт агрегатов после переходов слотов (любой бежит → busy). */
export function syncBusy(s: WebUiState): void {
  s.busy = s.pool.anyBusy();
  s.agentRunning = s.busy;
}

/**
 * Атомарно резервирует слот сессии (по умолчанию legacy без сессии),
 * возвращает токен владения.
 *
 * Звать СИНХРОННО в том же тике, что пречек busy: любой `await` между чеком
 * и резервом даст двум конкурентным сабмитам оба выиграть. Токен явно фиксирует
 * владельца сброса — поздний колбэк провала прошлого хода чужой резерв не снесёт.
 */
export function reserveBusy(s: WebUiState, id: string | null = null): object {
  const token = s.pool.reserve(id);
  syncBusy(s);
  return token;
}

/**
 * Отпускает слот, только если `token` всё ещё владеет им. Возвращает, был ли
 * вызывающий владельцем (чтобы скипнуть дублирующий бродкаст `state`, когда
 * форвардерный `turn_end` флаг уже сбросил).
 */
export function releaseBusy(s: WebUiState, token: object, id: string | null = null): boolean {
  const owned = s.pool.release(id, token);
  if (owned) syncBusy(s);
  return owned;
}
