// Сборка записи провайдера из флагов CLI/REPL.
//
// Единый источник для `mma provider add` и `/provider add`: лимиты задаёт
// пользователь (молчаливые 60/мин означали бы потолок, которого никто не
// просил — аудит §7.13), а не-числовые значения — ошибка, а не тихий NaN.
import type { ProviderEntry } from "../config/types";

/** Входные флаги провайдера. */
export interface ProviderEntryInput {
  name: string;
  baseUrl: string;
  apiKey?: string;
  priority?: string;
  contextWindow?: string;
  rpm?: string;
  parallel?: string;
}

/** Итог сборки записи. */
export type ProviderEntryResult =
  | { ok: true; entry: ProviderEntry }
  | { ok: false; error: "bad_number" };

/**
 * Собирает запись провайдера. Числовые флаги без значения (только `--parallel`)
 * не добавляют лимитов, которых не просил пользователь.
 */
export function buildProviderEntry(input: ProviderEntryInput): ProviderEntryResult {
  const rpm = input.rpm !== undefined ? Number(input.rpm) : undefined;
  const parallel = input.parallel !== undefined ? Number(input.parallel) : undefined;
  const priority = input.priority !== undefined ? Number(input.priority) : undefined;
  const contextWindow =
    input.contextWindow !== undefined ? Number(input.contextWindow) : undefined;

  const numbers = [rpm, parallel, priority, contextWindow];
  if (numbers.some((n) => n !== undefined && !Number.isFinite(n))) {
    return { ok: false, error: "bad_number" };
  }

  return {
    ok: true,
    entry: {
      type: input.name,
      label: input.name,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      ...(priority !== undefined ? { priority } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(rpm !== undefined || parallel !== undefined
        ? {
            rateLimits: {
              ...(rpm !== undefined ? { maxRequestsPerMinute: rpm } : {}),
              ...(parallel !== undefined ? { maxParallelTasks: parallel } : {}),
            },
          }
        : {}),
    },
  };
}
