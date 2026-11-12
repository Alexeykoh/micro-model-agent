/**
 * Вытеснение раннеров пула `mma web` (правило ≤300 строк).
 *
 * Вынесено из `session-pool.ts`: idle/LRU-чистка, периодический sweep и
 * освобождение вклада раннера. Пул передаёт геттеры/сеттеры своего состояния.
 */
import type { SessionRunner } from "../../../core/bootstrap/session-runner";
import { selectEvictions } from "./runner-gc";

/** Простой раннер без ходов (тесты). */
export const RUNNER_IDLE_MS = 10 * 60_000;

/** Сколько раннеров держим одновременно (LRU). */
export const RUNNER_LRU_MAX = 8;

/** Как часто чистим простаивающие раннеры. */
export const SWEEP_INTERVAL_MS = 60_000;

/** Состояние пула, которое видит чистка. */
export interface SweepState {
  runners: Map<string, SessionRunner>;
  lastActive: Map<string, number>;
  isBusy: (id: string) => boolean;
  disposeRunner: (id: string) => void;
  lastSweepAt: number | undefined;
  timer: ReturnType<typeof setInterval> | null;
}

/**
 * Вытесняет раннеры: простаивающие дольше `RUNNER_IDLE_MS` и лишние по LRU
 * (свыше `RUNNER_LRU_MAX`). Занятые и с очередью не трогаем (аудит §6.11).
 * @returns число вытесненных раннеров.
 */
export function sweepRunners(state: SweepState, now: number = Date.now()): number {
  state.lastSweepAt = now;
  const evict = selectEvictions(
    [...state.runners.keys()],
    state.lastActive,
    state.isBusy,
    now,
    RUNNER_IDLE_MS,
    RUNNER_LRU_MAX,
  );
  for (const id of evict) state.disposeRunner(id);
  return evict.length;
}

/** Периодическая чистка простаивающих раннеров (не держит процесс живым). */
export function startSweeper(state: SweepState, onSweep: () => void): void {
  if (state.timer) return;
  state.timer = setInterval(onSweep, SWEEP_INTERVAL_MS);
  state.timer.unref?.();
}

/** Чистка, если с прошлой прошло достаточно времени. */
export function sweepIfDue(state: SweepState, sweep: (now?: number) => number): void {
  const now = Date.now();
  const last = state.lastSweepAt;
  if (last !== undefined && now - last < SWEEP_INTERVAL_MS) return;
  sweep(now);
}

/** Останавливает периодическую чистку (стоп сервера). */
export function stopSweeper(state: SweepState): void {
  if (!state.timer) return;
  clearInterval(state.timer);
  state.timer = null;
}
