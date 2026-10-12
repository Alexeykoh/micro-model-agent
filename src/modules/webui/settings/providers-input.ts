// Парсинг и валидация входа `/api/providers` — вынесено из `providers-api.ts`
// (правило ≤300).
import type { CacheCapability } from "../../../config/types";

/** Вход add/update: обязательны тип и URL, остальное опционально. */
export interface ProviderInput {
  type: string;
  label?: string;
  baseUrl: string;
  apiKey?: string;
  contextWindow?: number;
  priority?: number;
  rpm?: number;
  parallel?: number;
  maxCompletionTokens?: number;
  cache?: Partial<CacheCapability>;
  retry?: { maxRetries?: number; baseDelay?: number; maxDelay?: number };
  /** Текущее имя правимой записи; при создании отсутствует. */
  originalName?: string;
}

function optionalInt(rec: Record<string, unknown>, key: string, min: number): number | null | undefined {
  return optionalIntRange(rec, key, min, Number.MAX_SAFE_INTEGER);
}

function optionalIntRange(
  rec: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | null | undefined {
  const v = rec[key];
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

const CACHE_MECHANISMS = ["auto", "explicit", "local", "none"];
const CACHE_REPORTS = ["openai", "deepseek", "anthropic", "ollama", "none"];
const CACHE_FLAGS = [
  "sessionHeader",
  "requestCachePrompt",
  "requestPromptCacheKey",
  "requestSessionId",
  "requestCacheControl",
  "requestStreamUsage",
] as const;

function coerceFlag(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === 0 || v === 1) return v === 1;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "1") return true;
    if (s === "false" || s === "0") return false;
  }
  return null;
}

/** Парсит потуловой объект оверрайда `cache`. `null` — мусор (400). */
function parseCache(v: unknown): Partial<CacheCapability> | null | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) return null;
  const rec = v as Record<string, unknown>;
  const out: Partial<CacheCapability> = {};
  if (rec.mechanism !== undefined) {
    if (typeof rec.mechanism !== "string" || !CACHE_MECHANISMS.includes(rec.mechanism)) return null;
    out.mechanism = rec.mechanism as CacheCapability["mechanism"];
  }
  if (rec.report !== undefined) {
    if (typeof rec.report !== "string" || !CACHE_REPORTS.includes(rec.report)) return null;
    out.report = rec.report as CacheCapability["report"];
  }
  for (const flag of CACHE_FLAGS) {
    const fv = rec[flag];
    if (fv === undefined) continue;
    const b = coerceFlag(fv);
    if (b === null) return null;
    out[flag] = b;
  }
  return out;
}

/** Парсит потуловой объект оверрайда `retry`. `null` — мусор (400). */
function parseRetry(
  v: unknown,
): { maxRetries?: number; baseDelay?: number; maxDelay?: number } | null | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) return null;
  const rec = v as Record<string, unknown>;
  const specs = [
    ["maxRetries", 0, 10],
    ["baseDelay", 0, 60000],
    ["maxDelay", 0, 300000],
  ] as const;
  const out: { maxRetries?: number; baseDelay?: number; maxDelay?: number } = {};
  for (const [key, min, max] of specs) {
    const n = optionalIntRange(rec, key, min, max);
    if (n === null) return null;
    if (n !== undefined) out[key] = n;
  }
  return out;
}

/** Парсит и валидирует тело POST. `null` — реджект с 400. */
export function parseProviderInput(rec: Record<string, unknown>): ProviderInput | null {
  const type = typeof rec.type === "string" ? rec.type.trim() : "";
  const baseUrl = typeof rec.baseUrl === "string" ? rec.baseUrl.trim() : "";
  if (!type || !baseUrl) return null;
  if (rec.apiKey !== undefined && rec.apiKey !== null && typeof rec.apiKey !== "string") return null;
  if (rec.label !== undefined && rec.label !== null && typeof rec.label !== "string") return null;
  if (rec.originalName !== undefined && rec.originalName !== null && typeof rec.originalName !== "string") {
    return null;
  }

  const contextWindow = optionalInt(rec, "contextWindow", 1024);
  const priority = optionalInt(rec, "priority", 0);
  const rpm = optionalInt(rec, "rpm", 1);
  const parallel = optionalInt(rec, "parallel", 1);
  if (contextWindow === null || priority === null || rpm === null || parallel === null) return null;

  const maxCompletionTokens = optionalIntRange(rec, "maxCompletionTokens", 512, 128000);
  if (maxCompletionTokens === null) return null;
  const cache = parseCache(rec.cache);
  if (cache === null) return null;
  const retry = parseRetry(rec.retry);
  if (retry === null) return null;

  const input: ProviderInput = { type, baseUrl };
  if (typeof rec.label === "string" && rec.label.trim()) input.label = rec.label.trim();
  if (typeof rec.originalName === "string" && rec.originalName.trim()) {
    input.originalName = rec.originalName.trim();
  }
  if (typeof rec.apiKey === "string" && rec.apiKey.trim()) input.apiKey = rec.apiKey.trim();
  if (contextWindow !== undefined) input.contextWindow = contextWindow;
  if (priority !== undefined) input.priority = priority;
  if (rpm !== undefined) input.rpm = rpm;
  if (parallel !== undefined) input.parallel = parallel;
  if (maxCompletionTokens !== undefined) input.maxCompletionTokens = maxCompletionTokens;
  if (cache !== undefined) input.cache = cache;
  if (retry !== undefined) input.retry = retry;
  return input;
}
