// Health-пробы провайдеров: дешёвый listModels, конкурентно, порядок входа сохраняется.
// src/modules/providers/health.ts
import type { LLMProvider } from "../../llm/provider";
import { errMsg } from "../../utils";

/** Одна цель пробы: именованный провайдер с (обычно бесплатным) listModels. */
export interface ProbeTarget {
  name: string;
  listModels(): Promise<string[]>;
}

/** Итог health-пробы провайдера. */
export interface ProviderHealth {
  name: string;
  ok: boolean;
  /** Длительность пробы в мс. */
  ms: number;
  /** Число моделей из listModels (0 при падении). */
  models: number;
  error?: string;
}

/** Опции пробы: таймаут. */
export interface ProbeOptions {
  timeoutMs?: number;
}

/**
 * Пробить провайдеры конкурентно и отчитаться ✓/✗ по каждой записи.
 * Только `listModels()` — бесплатный дешёвый вызов, никогда не платный chat.
 * Порядок входа в выводе сохраняется.
 */
export async function probeProviders(
  targets: ProbeTarget[],
  opts?: ProbeOptions,
): Promise<ProviderHealth[]> {
  const timeoutMs = opts?.timeoutMs ?? 5000;
  const results = await Promise.all(targets.map((t) => probeOne(t, timeoutMs)));
  return results;
}

async function probeOne(target: ProbeTarget, timeoutMs: number): Promise<ProviderHealth> {
  const start = Date.now();
  try {
    const models = await withTimeout(target.listModels(), timeoutMs);
    return { name: target.name, ok: true, ms: Date.now() - start, models: models.length };
  } catch (err) {
    const message = errMsg(err);
    return {
      name: target.name,
      ok: false,
      ms: Date.now() - start,
      models: 0,
      error: message,
    };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Собрать цели проб из маппинга имя→провайдер (порядок приоритетов). */
export function targetsFromProviders(
  entries: Array<{ name: string; provider: LLMProvider }>,
): ProbeTarget[] {
  return entries.map(({ name, provider }) => ({
    name,
    listModels: () => provider.listModels(),
  }));
}
