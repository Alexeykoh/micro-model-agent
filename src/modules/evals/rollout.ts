/**
 * staged rollout (Evals 2/2): детерминированное распределение потока по
 * бакету threadId (canary/percentage). Чистый хелпер — без смены маршрутизации
 * провайдеров (живое переключение — отдельная волна).
 */
import { createHash } from "node:crypto";

/** Бакет 0..99 для threadId (стабилен между запусками). */
export function rolloutBucket(threadId: string): number {
  const digest = createHash("sha256").update(threadId).digest();
  return digest[0] % 100;
}

/** Попадает ли поток в `percentage`% rollout (canary/percentage-режим). */
export function inRollout(threadId: string, percentage: number): boolean {
  if (!Number.isFinite(percentage) || percentage <= 0) return false;
  if (percentage >= 100) return true;
  return rolloutBucket(threadId) < percentage;
}

/** Режим раскатки: shadow (0–100 подсказка), canary (1–10), percentage, full. */
export function rolloutMode(percentage: number): "shadow" | "canary" | "percentage" | "full" {
  if (percentage >= 100) return "full";
  if (percentage <= 0) return "shadow";
  if (percentage <= 10) return "canary";
  return "percentage";
}

/**
 * Живая маршрутизация раскатки: при попадании threadId в процент и
 * существующей записи-кандидате — переключает менеджера на кандидата.
 * Возвращает `true`, если переключено. Fail-open: менеджер-стейб в
 * тестах равен интерфейсу ниже.
 */
export function applyStagedRollout(
  manager: { switch(name: string): void; listNames(): string[] },
  threadId: string | undefined,
  rollout: { candidate?: string; percentage?: number } | undefined,
): boolean {
  const percentage = rollout?.percentage ?? 0;
  if (!threadId || !rollout?.candidate || !(percentage > 0)) return false;
  if (!manager.listNames().includes(rollout.candidate)) return false;
  if (!inRollout(threadId, percentage)) return false;
  manager.switch(rollout.candidate);
  return true;
}
