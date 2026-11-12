// OpenAI-compat `/models`: разбор context-метаданных и декларативных
// capabilities + общий хелпер «сервер ответил?». Вынесено из `native-context.ts`
// (правило 6: ≤300 строк на файл).
import type { ModelCapabilities } from "../config/types";

/** Числовые context-подобные поля, что может нести запись `/models`. */
const CONTEXT_KEYS = [
  "context_length",
  "context_window",
  "max_context_length",
  "max_context_window",
  "max_model_len",
  "maxModelLen",
  "n_ctx",
  "num_ctx",
  "contextLength",
  "contextWindow",
] as const;

/** Положительный int из числа/строки; иначе null. */
export function asPositiveInt(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * Первое положительное среди известных context-полей объекта. OpenRouter
 * кладёт per-endpoint значение в `top_provider.context_length`, а OpenCode
 * Zen/Go — в `limit.context` (проверено вживую 2026-11-10: `/models` отдаёт
 * `limit: {context, output}`), поэтому обе вложенности покрыты.
 */
export function pickContextField(obj: Record<string, unknown>): number | null {
  for (const k of CONTEXT_KEYS) {
    const n = asPositiveInt(obj[k]);
    if (n !== null) return n;
  }
  const top = obj.top_provider ?? obj.topProvider;
  if (top && typeof top === "object") {
    for (const k of CONTEXT_KEYS) {
      const n = asPositiveInt((top as Record<string, unknown>)[k]);
      if (n !== null) return n;
    }
  }
  const limit = obj.limit;
  if (limit && typeof limit === "object") {
    const n = asPositiveInt((limit as Record<string, unknown>).context);
    if (n !== null) return n;
  }
  return null;
}

/** Совпадает ли запись `/models` с запрошенной моделью (id/name/model/key). */
export function matchesModel(entry: Record<string, unknown>, model: string): boolean {
  for (const k of ["id", "name", "model", "key"]) {
    const v = entry[k];
    if (typeof v === "string" && v && (v === model || model.includes(v) || v.includes(model))) {
      return true;
    }
  }
  return false;
}

/** Итог `/models`-запроса: список (если пригоден) + факт «сервер ответил». */
export interface CompatModelsList {
  /** true — пришёл любой HTTP-ответ (даже 404/401), то есть эндпоинт жив. */
  reachable: boolean;
  list: Record<string, unknown>[] | null;
}

/**
 * Список моделей OpenAI-compat `/models` (общая часть context- и
 * capabilities-проб). `reachable` отличает «сервер не ответил» (сеть/таймаут)
 * от «ответил, но списка нет»: второе доказывает достижимость, а `null`-список
 * значит лишь «метаданных модели нет».
 */
export async function fetchOpenAICompatModelsList(
  baseUrl: string,
  apiKey: string | undefined,
  timeoutMs: number,
): Promise<CompatModelsList> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey && apiKey !== "not-needed") headers.Authorization = `Bearer ${apiKey}`;
  let reachable = false;
  let data: unknown = null;
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    reachable = true;
    if (response.ok) data = (await response.json()) as unknown;
  } catch {
    // сети нет / таймаут — ответа не было
  }
  const list = (data as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) return { reachable, list: null };
  return {
    reachable,
    list: list.filter((m): m is Record<string, unknown> => !!m && typeof m === "object"),
  };
}

/**
 * OpenAI-совместимый `/models` с расширенными метаданными. Серверы с голыми id
 * (чистый OpenAI, Zen/Go) context-полей не несут → null.
 */
export async function probeOpenAICompatModels(
  baseUrl: string,
  model: string,
  apiKey: string | undefined,
  timeoutMs: number,
): Promise<number | null> {
  const { list } = await fetchOpenAICompatModelsList(baseUrl, apiKey, timeoutMs);
  const found = list?.find((m) => matchesModel(m, model));
  if (!found) return null;
  return pickContextField(found);
}

/**
 * Декларативные возможности reasoning из OpenAI-compat `/models`
 * (`capabilities.reasoning: {supported, effort}` — OpenCode Zen/Go и т.п.).
 * Выключатель здесь НЕ декларируется — он выясняется эмпирически
 * (`probeReasoningOffSwitch`), поэтому `reasoningOff` мы не ставим.
 */
export interface OpenAICompatCapabilitiesProbe {
  reachable: boolean;
  capabilities?: ModelCapabilities;
}

export async function probeOpenAICompatCapabilities(
  baseUrl: string,
  model: string,
  apiKey: string | undefined,
  timeoutMs: number,
): Promise<OpenAICompatCapabilitiesProbe> {
  const { reachable, list } = await fetchOpenAICompatModelsList(baseUrl, apiKey, timeoutMs);
  // Ответил хоть чем-то (404 без `/models`) — эндпоинт доступен, просто
  // capabilities не декларирует; недоступность — только отсутствие ответа.
  if (!reachable) return { reachable: false };
  if (list === null) return { reachable: true };
  const found = list.find((m) => matchesModel(m, model));
  if (!found) return { reachable: true };
  const raw = found.capabilities;
  if (!raw || typeof raw !== "object") return { reachable: true };
  const reasoning = (raw as { reasoning?: unknown }).reasoning;
  if (!reasoning || typeof reasoning !== "object") return { reachable: true };
  const r = reasoning as { supported?: unknown; effort?: unknown };
  const capabilities: ModelCapabilities = {};
  if (r.supported === true) capabilities.reasoningStrategy = "openai-effort";
  if (Array.isArray(r.effort)) {
    const levels = r.effort.filter((v): v is string => typeof v === "string");
    if (levels.length > 0) capabilities.reasoningLevels = levels;
  }
  return {
    reachable: true,
    capabilities: Object.keys(capabilities).length > 0 ? capabilities : undefined,
  };
}
