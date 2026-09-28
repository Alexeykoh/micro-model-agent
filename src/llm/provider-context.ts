/**
 * Универсальная проба контекста провайдера: что бэкенд РЕАЛЬНО отдаёт для
 * `model` прямо сейчас — длина загруженного инстанса (LM Studio/Ollama/
 * llama.cpp), а не максимум карточки модели.
 *
 * Порядок: LM Studio native → Ollama native → llama.cpp `/props` →
 * OpenAI-compat `/models`-метаданные (`context_length`, vLLM `max_model_len`,
 * OpenRouter `top_provider.context_length`) → каталог models.dev (последний
 * шанс, только для OpenCode Zen/Go, чей `/models` отдаёт голые id — проверено
 * вживую: `{id, object, created, owned_by}` без context-полей).
 *
 * Null, если окно никто не сообщил — вызывающий хранит настроенный
 * `contextWindow` (fail-open).
 */
import type { ModelCapabilities } from "../config/types";
import { lookupModelsDevContext } from "./models-dev";

/** Итог стартовой context-probe: с чем модель РЕАЛЬНО загружена. */
export interface ContextProbeResult {
  model: string;
  /** Длина контекста загруженного инстанса (токены). */
  actual: number;
}

/** Итог нативной пробы модели: окно контекста + заявленные capabilities. */
export interface ModelProbeResult {
  model: string;
  /** Длина контекста загруженного инстанса (токены). */
  contextLength: number;
  /** Заявленные capabilities, если бэкенд их сообщает (LM Studio). */
  capabilities?: ModelCapabilities;
}

/** Минимальная форма записи LM Studio `/api/v1/models`, что нам нужна. */
interface LmStudioModel {
  key?: string;
  name?: string;
  max_context_length?: number;
  loaded_instances?: Array<{ config?: { context_length?: number } }>;
  capabilities?: { vision?: boolean; trained_for_tool_use?: boolean };
}
interface LmStudioModelsResponse {
  models?: LmStudioModel[];
}

/**
 * Спрашивает нативный API бэкенда (LM Studio `/api/v1/models`) о длине
 * контекста загруженной модели И заявленных capabilities. Длина — из живого
 * инстанса (`loaded_instances[].config.context_length`), фолбэк —
 * `max_context_length`. Capabilities читаются из `capabilities` (`vision`,
 * `trained_for_tool_use`), если есть — это единый источник правды вместо
 * гадания по имени.
 *
 * Null, если эндпоинт недоступен (не LM Studio), модели нет/снята или запрос
 * упал — вызывающий деградирует молча.
 */
export async function probeModel(
  baseUrl: string,
  model: string,
  timeoutMs = 3000,
): Promise<ModelProbeResult | null> {
  const base = baseUrl.replace(/\/$/, "").replace(/\/v1\/?$/, "");
  try {
    const response = await fetch(`${base}/api/v1/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as LmStudioModelsResponse;
    const models = data.models ?? [];
    const found = models.find(
      (m) => m.key === model || m.name === model || (m.key ? model.includes(m.key) : false),
    );
    if (!found) return null;
    const loadedInstance = (found.loaded_instances ?? [])[0];
    const contextLength = loadedInstance?.config?.context_length ?? found.max_context_length;
    if (typeof contextLength !== "number" || contextLength <= 0) return null;

    const raw = found.capabilities;
    let capabilities: ModelCapabilities | undefined;
    if (raw && typeof raw.vision === "boolean") {
      capabilities = { vision: raw.vision };
      if (typeof raw.trained_for_tool_use === "boolean") {
        capabilities.tools = raw.trained_for_tool_use;
      }
    }

    return { model: found.key ?? found.name ?? model, contextLength, capabilities };
  } catch {
    return null;
  }
}

/**
 * Тонкая context-only проекция {@link probeModel}. Для вызывающих, кому нужно
 * только окно контекста (баннер, диагностика context-probe).
 */
export async function getLoadedContextLength(
  baseUrl: string,
  model: string,
  timeoutMs = 3000,
): Promise<ContextProbeResult | null> {
  const probe = await probeModel(baseUrl, model, timeoutMs);
  return probe ? { model: probe.model, actual: probe.contextLength } : null;
}

/** Опции пробы контекста: ключ, таймаут, тип провайдера. */
export interface ProviderContextOpts {
  /** Bearer-ключ для хостед OpenAI-совместимых эндпоинтов (OpenRouter, Zen/Go). */
  apiKey?: string;
  timeoutMs?: number;
  /** Тип из реестра (`openai-compat`, `opencode-zen`, …) — гейтит models.dev. */
  providerType?: string;
}

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
 * кладёт per-endpoint значение в `top_provider.context_length`, поэтому один
 * уровень вложенности тоже покрыт.
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
  for (const name of [model, short]) {
    const show = await fetchJson(`${origin}/api/show`, timeoutMs, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const info = (show as { model_info?: Record<string, unknown>; modelInfo?: Record<string, unknown> } | null);
    const bag = info?.model_info ?? info?.modelInfo;
    if (bag && typeof bag === "object") {
      const n = contextFromModelInfo(bag as Record<string, unknown>);
      if (n !== null) return n;
    }
  }
  return null;
}

/** Нативный Ollama: живые инстансы (`/api/ps`) + детали (`/api/show`). */
async function probeOllama(origin: string, model: string, timeoutMs: number): Promise<number | null> {
  // `/api/show` сообщает контекст модели (напр. `llama.context_length` в
  // `model_info`), даже когда `/api/ps` размерных полей не несёт.
  return (
    (await probeOllamaPs(origin, model, timeoutMs)) ??
    (await probeOllamaShow(origin, model, timeoutMs))
  );
}

/** Сервер llama.cpp: одномодельный `/props` несёт загруженный `n_ctx`. */
async function probeLlamaCpp(origin: string, timeoutMs: number): Promise<number | null> {
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

/**
 * OpenAI-совместимый `/models` с расширенными метаданными. Серверы с голыми id
 * (чистый OpenAI, Zen/Go) context-полей не несут → null.
 */
async function probeOpenAICompatModels(
  baseUrl: string,
  model: string,
  apiKey: string | undefined,
  timeoutMs: number,
): Promise<number | null> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey && apiKey !== "not-needed") headers.Authorization = `Bearer ${apiKey}`;
  const data = await fetchJson(url, timeoutMs, { headers });
  const list = (data as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) return null;
  const found = list.find(
    (m): m is Record<string, unknown> => !!m && typeof m === "object" && matchesModel(m as Record<string, unknown>, model),
  );
  if (!found) return null;
  return pickContextField(found);
}

/**
 * Лукап каталога models.dev — последний шанс для OpenCode Zen/Go. Их `/models`
 * отдаёт голые id, а models.dev (открытая БД, что использует сам opencode)
 * держит модели провайдера `opencode` под теми же id с `limit.context`.
 * Гейт на Zen-URL/тип: локальные бэкенды ради этого в сеть не ходят.
 */
async function probeModelsDev(
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

/**
 * Пробует все источники по порядку, возвращает первый давший окно.
 * @param baseUrl базовый URL провайдера; @param model имя модели;
 * @param opts ключ/таймаут/тип; @returns окно контекста либо null (fail-open).
 */
export async function probeProviderContext(
  baseUrl: string,
  model: string,
  opts: ProviderContextOpts = {},
): Promise<ContextProbeResult | null> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const origin = baseUrl.replace(/\/$/, "").replace(/\/v1\/?$/, "");
  try {
    const lm = await probeModel(baseUrl, model, timeoutMs);
    if (lm) return { model: lm.model, actual: lm.contextLength };
    const ollama = await probeOllama(origin, model, timeoutMs);
    if (ollama !== null) return { model, actual: ollama };
    const llama = await probeLlamaCpp(origin, timeoutMs);
    if (llama !== null) return { model, actual: llama };
    const compat = await probeOpenAICompatModels(baseUrl, model, opts.apiKey, timeoutMs);
    if (compat !== null) return { model, actual: compat };
    const catalog = await probeModelsDev(baseUrl, model, opts.providerType);
    if (catalog !== null) return { model, actual: catalog };
  } catch {
    // Fail-open: любая ошибка пробы оставляет настроенный contextWindow.
  }
  return null;
}
