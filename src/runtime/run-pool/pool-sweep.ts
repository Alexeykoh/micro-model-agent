/**
 * Вытеснение раннеров пула (правило ≤300 строк).
 *
 * Вынесено из `run-pool.ts`: idle/LRU-чистка, периодический sweep и
 * самостоятельное гашение таймера. Не держит состояний — мутабельный
 * `SweepState` передаёт владелец пула.
 */
import type { SessionRunner } from "../../core/bootstrap/session-runner";
import { selectEvictions } from "./runner-gc";

/** Простой раннера для вытеснения (мс). */
export const RUNNER_IDLE_MS = 10 * 60_000;

/** Сколько раннеров держим максимум (LRU). */
export const RUNNER_LRU_MAX = 8;

/** Как часто чистим простаивающие раннеры. */
export const SWEEP_INTERVAL_MS = 60_000;

/** Входы пула, которые нужны для чистки. */
export interface SweepState {
  runners: Map<string, SessionRunner>;
  lastActive: Map<string, number>;
  isBusy: (id: string) => boolean;
  disposeRunner: (id: string) => void;
  lastSweepAt: number | undefined;
  timer: ReturnType<typeof setInterval> | null;
}

/**
 * Чистит раннеры: простаивающие дольше `RUNNER_IDLE_MS` и лишние по LRU
 * (сверх `RUNNER_LRU_MAX`). Занятые не трогаем (аудит §6.11).
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
