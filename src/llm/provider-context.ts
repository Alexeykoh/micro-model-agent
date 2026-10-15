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
import {
  probeOllama,
  probeLlamaCpp,
  probeOpenAICompatModels,
  probeModelsDev,
} from "./native-context";

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
  capabilities?: {
    vision?: boolean;
    trained_for_tool_use?: boolean;
    /** Нативный вердикт о reasoning: какие опции эндпоинт принимает. */
    reasoning?: { allowed_options?: string[]; default?: string };
  };
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
    // Discovery механизма reasoning (INV-R2, средний слой): эндпоинт объявил,
    // что умеет выключать thinking. LM Studio выражает это полем
    // `reasoning_effort: "none"` (проверено вживую на Qwen3), а не kwarg/тегом —
    // поэтому стратегия `openai-effort` + флаг `reasoningOff`.
    if (raw?.reasoning?.allowed_options?.includes("off")) {
      capabilities ??= {};
      capabilities.reasoningStrategy = "openai-effort";
      capabilities.reasoningOff = true;
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
