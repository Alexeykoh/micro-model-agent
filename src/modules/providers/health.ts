// src/modules/providers/health.ts
import type { LLMProvider } from "../../llm/provider";

/** One probe target: a named provider with a (usually free) listModels call. */
export interface ProbeTarget {
  name: string;
  listModels(): Promise<string[]>;
}

export interface ProviderHealth {
  name: string;
  ok: boolean;
  /** Elapsed milliseconds of the probe call. */
  ms: number;
  /** Number of models returned by listModels (0 on failure). */
  models: number;
  error?: string;
}

export interface ProbeOptions {
  timeoutMs?: number;
}

/**
 * Probe providers concurrently (bounded by the caller passing few entries)
 * and report ✓/✗ per entry. Uses `listModels()` — a free, cheap call — never
 * a billed chat completion. Input order is preserved in the output.
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
    const message = err instanceof Error ? err.message : String(err);
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

/** Build probe targets from a name→provider mapping (priority order). */
export function targetsFromProviders(
  entries: Array<{ name: string; provider: LLMProvider }>,
): ProbeTarget[] {
  return entries.map(({ name, provider }) => ({
    name,
    listModels: () => provider.listModels(),
  }));
}
