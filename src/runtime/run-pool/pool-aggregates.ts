/**
 * Агрегаты слотов пула (правило ≤300 строк).
 *
 * Вынесено из `run-pool.ts`: производные проекции занятости (busy-слоты,
 * счётчики очередей) для состояния веба и legacy-полей `s.busy`/`s.queueLen`.
 */
import type { RunSlot } from "./run-pool";

/** Id занятых сессионных слотов (для legacy — без служебного слота). */
export function busyIdsOf(slots: Map<string, RunSlot>): string[] {
  const out: string[] = [];
  for (const [key, slot] of slots) {
    if (key !== "" && slot.busy) out.push(key);
  }
  return out;
}

/** Занят ли хоть один слот (агрегат для legacy `s.busy`). */
export function anyBusyOf(slots: Map<string, RunSlot>): boolean {
  for (const slot of slots.values()) {
    if (slot.busy) return true;
  }
  return false;
}

/** Счётчики очереди по сессиям (для legacy — без служебного). */
export function queuedCountsOf(slots: Map<string, RunSlot>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, slot] of slots) {
    if (key === "") continue;
    if (slot.queue.length > 0) out[key] = slot.queue.length;
  }
  return out;
}

/** Длина всех очередей (агрегат для legacy `queueLen`). */
export function totalQueuedOf(slots: Map<string, RunSlot>): number {
  let n = 0;
  for (const slot of slots.values()) n += slot.queue.length;
  return n;
}

/** Id очередей по сессиям (без legacy-слота, как `queuedCounts`). */
export function queuedIdsBySessionOf(slots: Map<string, RunSlot>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, slot] of slots) {
    if (key === "" || slot.queue.length === 0) continue;
    out[key] = slot.queue.ids();
  }
  return out;
}
