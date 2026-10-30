// Read-проекции страницы настроек «Модель и провайдер» `mma web` (без HTTP/персиста).
/**
 * Вынесены из `providers-api.ts` (правило #1: ≤300 строк/файл). Чистые проекции
 * конфиг → вид; секреты не эхом: read-форма отдаёт `hasApiKey` вместо ключа.
 */
import type { AppConfig, CacheCapability, ProviderEntry } from "../../../config/types";
import { BUILTIN_PROVIDERS } from "../../providers/presets";

/** Отредактированная запись провайдера для UI настроек. */
export interface ProviderView {
  type: string;
  label: string;
  baseUrl: string;
  contextWindow?: number;
  priority?: number;
  rpm?: number;
  parallel?: number;
  maxCompletionTokens?: number;
  cache?: Partial<CacheCapability>;
  retry?: { maxRetries?: number; baseDelay?: number; maxDelay?: number };
  hasApiKey: boolean;
}

/** Встроенный шаблон провайдера для выбора в один клик в UI. */
export interface ProviderPresetView {
  /** Уникальный ключ UI (`type` для встроенных, стабильный слаг для локальных). */
  id: string;
  /** Тип провайдера реестра, пишущийся в конфиг. */
  type: string;
  /** Предложенное имя провайдера (уникальность между записями обязательна). */
  name: string;
  label: string;
  baseUrl?: string;
}

/**
 * Именованные локальные эндпоинты: тот же тип `openai-compat` с известными base URL,
 * чтобы локальному сетапу тоже не нужно было знание URL. (LM Studio вырос в
 * настоящий builtin-пресет `lmstudio` и здесь больше не дублируется.)
 */
const LOCAL_PRESETS: ProviderPresetView[] = [
  {
    id: "ollama",
    type: "openai-compat",
    name: "ollama",
    label: "Ollama (localhost:11434)",
    baseUrl: "http://localhost:11434/v1",
  },
  {
    id: "vllm",
    type: "openai-compat",
    name: "vllm",
    label: "vLLM (localhost:8000)",
    baseUrl: "http://localhost:8000/v1",
  },
];

/** Встроенные пресеты с фиксированными base URL (у хостедных он есть). */
export function buildProviderPresets(): ProviderPresetView[] {
  const builtin: ProviderPresetView[] = BUILTIN_PROVIDERS.map((spec) => {
    const preset: ProviderPresetView = {
      id: spec.type,
      type: spec.type,
      name: spec.type,
      label: spec.label,
    };
    if (spec.baseUrl) preset.baseUrl = spec.baseUrl;
    return preset;
  });
  return [...builtin, ...LOCAL_PRESETS];
}

/** Нормализует `config.provider` в список для показа + имя активного. */
export function buildProviderViews(config: AppConfig): {
  entries: ProviderView[];
  active: string;
  presets: ProviderPresetView[];
} {
  const provider = config.provider;
  const raw: ProviderEntry[] =
    Array.isArray(provider.entries) && provider.entries.length > 0
      ? provider.entries
      : [{ type: provider.type, baseUrl: provider.baseUrl, apiKey: provider.apiKey }];
  const entries = raw.map((e) => {
    const view: ProviderView = {
      type: e.type,
      label: e.label || e.type,
      baseUrl: e.baseUrl,
      hasApiKey: Boolean(e.apiKey),
    };
    if (e.contextWindow !== undefined) view.contextWindow = e.contextWindow;
    if (e.priority !== undefined) view.priority = e.priority;
    if (e.maxCompletionTokens !== undefined) view.maxCompletionTokens = e.maxCompletionTokens;
    if (e.cache !== undefined) view.cache = { ...e.cache };
    if (e.retry !== undefined) view.retry = { ...e.retry };
    if (e.rateLimits) {
      view.rpm = e.rateLimits.maxRequestsPerMinute;
      view.parallel = e.rateLimits.maxParallelTasks;
    }
    return view;
  });
  const labels = entries.map((e) => e.label);
  // Активное имя обязано указывать на существующую запись: легаси `type`
  // (например `lmstudio` при активном `opencode-go`) давал «ни одного
  // активного» в UI и расходился с чипом композера.
  const active =
    provider.active && labels.includes(provider.active)
      ? provider.active
      : (labels[0] ?? provider.type);
  return { entries, active, presets: buildProviderPresets() };
}
