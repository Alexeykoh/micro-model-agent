// Нативные пробы контекста бэкендов (Ollama / llama.cpp / OpenAI-compat
// /models / models.dev) — вынесено из `provider-context.ts` (правило ≤300).
import { lookupModelsDevContext } from "./models-dev";
import type { ModelCapabilities, ReasoningStrategy } from "../config/types";

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

function asPositiveInt(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * Первое положительное среди известных context-полей объекта. OpenRouter
 * кладёт per-endpoint значение в `top_provider.context_length`, а OpenCode
 * Zen/Go — в `limit.context` (проверено вживую 2026-11-10: `/models` отдаёт
 * `limit: {context, output}`), поэтому обе вложенности покрыты.
 */
function pickContextField(obj: Record<string, unknown>): number | null {
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

function matchesModel(entry: Record<string, unknown>, model: string): boolean {
  for (const k of ["id", "name", "model", "key"]) {
    const v = entry[k];
    if (typeof v === "string" && v && (v === model || model.includes(v) || v.includes(model))) {
      return true;
    }
  }
  return false;
}

async function fetchJson(url: string, timeoutMs: number, init?: RequestInit): Promise<unknown | null> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

/** Context-поля живого инстанса из Ollama `/api/ps`, если есть. */
async function probeOllamaPs(
  origin: string,
  model: string,
  timeoutMs: number,
): Promise<number | null> {
  const ps = await fetchJson(`${origin}/api/ps`, timeoutMs);
  const running = (ps as { models?: Record<string, unknown>[] } | null)?.models;
  if (!Array.isArray(running)) return null;
  const found = running.find(
    (m) => m && typeof m === "object" && matchesModel(m as Record<string, unknown>, model),
  );
  if (!found) return null;
  return pickContextField(found as Record<string, unknown>);
}

function contextFromModelInfo(bag: Record<string, unknown>): number | null {
  for (const [k, v] of Object.entries(bag)) {
    if (k.toLowerCase().includes("context_length") || k.toLowerCase().endsWith("n_ctx")) {
      const n = asPositiveInt(v);
      if (n !== null) return n;
    }
  }
  return pickContextField(bag);
}

/** Ollama `/api/show`: детали модели, пробуем полное и короткое имя. */
async function probeOllamaShow(
  origin: string,
  model: string,
  timeoutMs: number,
): Promise<number | null> {
  const short = model.split(":")[0];
  // Оба имени — параллельно: порядок имён задаёт приоритет ответа.
  const names = short === model || short === "" ? [model] : [model, short];
  const shows = await Promise.all(
    names.map((name) =>
      fetchJson(`${origin}/api/show`, timeoutMs, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }),
    ),
  );
  for (const show of shows) {
    const info = show as {
      model_info?: Record<string, unknown>;
      modelInfo?: Record<string, unknown>;
    } | null;
    const bag = info?.model_info ?? info?.modelInfo;
    if (bag && typeof bag === "object") {
      const n = contextFromModelInfo(bag as Record<string, unknown>);
      if (n !== null) return n;
    }
  }
  return null;
}

/** Нативный Ollama: живые инстансы (`/api/ps`) + детали (`/api/show`). */
export async function probeOllama(
  origin: string,
  model: string,
  timeoutMs: number,
): Promise<number | null> {
  // `/api/show` сообщает контекст модели (напр. `llama.context_length` в
  // `model_info`), даже когда `/api/ps` размерных полей не несёт. Оба источника
  // гоняются параллельно (приоритет у `/api/ps`): медленный `/api/show` не
  // должен удваивать время пробы Ollama.
  const [ps, show] = await Promise.all([
    probeOllamaPs(origin, model, timeoutMs),
    probeOllamaShow(origin, model, timeoutMs),
  ]);
  return ps ?? show;
}

/** Сервер llama.cpp: одномодельный `/props` несёт загруженный `n_ctx`. */
export async function probeLlamaCpp(origin: string, timeoutMs: number): Promise<number | null> {
  const props = await fetchJson(`${origin}/props`, timeoutMs);
  if (!props || typeof props !== "object") return null;
  const bag = props as Record<string, unknown>;
  const direct = pickContextField(bag);
  if (direct !== null) return direct;
  const gen = bag.default_generation_settings;
  if (gen && typeof gen === "object") {
    return pickContextField(gen as Record<string, unknown>);
  }
  return null;
}

/** Механизм reasoning, объявленный llama.cpp в `/props` (INV-R6). */
export interface LlamaCppReasoningCaps {
  strategy: ReasoningStrategy;
  reasoningOff: boolean;
  /** Объявленные значения `reasoning_effort` (INV-R7). */
  levels?: string[];
}

/**
 * llama.cpp `/props.chat_template_caps`: сервер сам сообщает, умеет ли он
 * `reasoning_effort` и какие значения принимает. Фолбэк — `enable_thinking`
 * в шаблоне (kwarg выключает thinking). Null = механизм не объявлен.
 */
export async function probeLlamaCppReasoning(
  origin: string,
  timeoutMs: number,
): Promise<LlamaCppReasoningCaps | null> {
  const props = await fetchJson(`${origin}/props`, timeoutMs);
  if (!props || typeof props !== "object") return null;
  const bag = props as Record<string, unknown>;
  const caps = bag.chat_template_caps;
  if (caps && typeof caps === "object") {
    const c = caps as Record<string, unknown>;
    if (c.supports_reasoning_effort === true) {
      const levels = Array.isArray(c.reasoning_effort_levels)
        ? c.reasoning_effort_levels.filter((v): v is string => typeof v === "string")
        : undefined;
      // llama.cpp принимает "none" как выключатель (проверено вживую).
      return { strategy: "openai-effort", reasoningOff: true, levels };
    }
  }
  if (typeof bag.chat_template === "string" && bag.chat_template.includes("enable_thinking")) {
    return { strategy: "template-kwarg", reasoningOff: true };
  }
  return null;
}

/**
 * Список моделей OpenAI-compat `/models` (общая часть context- и
 * capabilities-проб): `null` при любом промахе.
 */
async function fetchOpenAICompatModelsList(
  baseUrl: string,
  apiKey: string | undefined,
  timeoutMs: number,
): Promise<Record<string, unknown>[] | null> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey && apiKey !== "not-needed") headers.Authorization = `Bearer ${apiKey}`;
  const data = await fetchJson(url, timeoutMs, { headers });
  const list = (data as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) return null;
  return list.filter((m): m is Record<string, unknown> => !!m && typeof m === "object");
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
  const list = await fetchOpenAICompatModelsList(baseUrl, apiKey, timeoutMs);
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
export async function probeOpenAICompatCapabilities(
  baseUrl: string,
  model: string,
  apiKey: string | undefined,
  timeoutMs: number,
): Promise<ModelCapabilities | null> {
  const list = await fetchOpenAICompatModelsList(baseUrl, apiKey, timeoutMs);
  const found = list?.find((m) => matchesModel(m, model));
  if (!found) return null;
  const raw = found.capabilities;
  if (!raw || typeof raw !== "object") return null;
  const reasoning = (raw as { reasoning?: unknown }).reasoning;
  if (!reasoning || typeof reasoning !== "object") return null;
  const r = reasoning as { supported?: unknown; effort?: unknown };
  const capabilities: ModelCapabilities = {};
  if (r.supported === true) capabilities.reasoningStrategy = "openai-effort";
  if (Array.isArray(r.effort)) {
    const levels = r.effort.filter((v): v is string => typeof v === "string");
    if (levels.length > 0) capabilities.reasoningLevels = levels;
  }
  return Object.keys(capabilities).length > 0 ? capabilities : null;
}

/**
 * Лукап каталога models.dev — последний шанс, когда `/models` не сообщил окно
 * (старые ответы Zen/Go были без context-полей; гейт на Zen-URL/тип остаётся,
 * чтобы локальные бэкенды ради каталога не ходили в сеть).
 */
export async function probeModelsDev(
  baseUrl: string,
  model: string,
  providerType: string | undefined,
): Promise<number | null> {
  const isZen =
    providerType === "opencode-zen" ||
    providerType === "opencode-go" ||
    /opencode\.ai\/zen/.test(baseUrl);
  if (!isZen) return null;
  return lookupModelsDevContext(model);
}
