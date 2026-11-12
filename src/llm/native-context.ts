// Нативные пробы контекста бэкендов (Ollama / llama.cpp / OpenAI-compat
// /models / models.dev) — вынесено из `provider-context.ts` (правило ≤300).
import { lookupModelsDevContext } from "./models-dev";
import { asPositiveInt, matchesModel, pickContextField } from "./openai-compat-models";
import type { ReasoningStrategy } from "../config/types";

// `/models`-часть (context-поля, декларативные capabilities, достижимость)
// живёт в `openai-compat-models.ts`; реэкспорт — публичный API прежнего места.
export {
  probeOpenAICompatModels,
  probeOpenAICompatCapabilities,
  type OpenAICompatCapabilitiesProbe,
} from "./openai-compat-models";

async function fetchJson(
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<unknown | null> {
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
