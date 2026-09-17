import type { ModelPrice, PricingConfig } from "../../config/types";

/**
 * Built-in price table (USD per 1M tokens) for OpenCode Zen / Go models.
 * Values from https://opencode.ai/docs/zen/ and /docs/go/ (August 2026).
 * Model ids are stored WITHOUT the `opencode/` or `opencode-go/` prefix so a
 * single table serves both providers; lookup strips the prefix.
 */
const ZEN_PRICES: Record<string, ModelPrice> = {
  // Free models
  "big-pickle": { input: 0, output: 0 },
  "mimo-v2.5-free": { input: 0, output: 0 },
  "hy3-free": { input: 0, output: 0 },
  "nemotron-3-ultra-free": { input: 0, output: 0 },
  "nemotron-3.5-lightning-free": { input: 0, output: 0 },
  "muse-spark-1.2-contributor-free": { input: 0, output: 0 },
  // MiniMax (Cached Read по прайсу Zen)
  "minimax-m3": { input: 0.3, output: 1.2, cachedInput: 0.06 },
  "minimax-m2.7": { input: 0.3, output: 1.2, cachedInput: 0.06 },
  "minimax-m2.5": { input: 0.3, output: 1.2, cachedInput: 0.06 },
  // GLM (Cached Read по прайсу Zen)
  "glm-5.2": { input: 1.4, output: 4.4, cachedInput: 0.26 },
  "glm-5.1": { input: 1.4, output: 4.4, cachedInput: 0.26 },
  "glm-5": { input: 1.0, output: 3.2, cachedInput: 0.2 },
  "glm-5.3": { input: 1.4, output: 4.4 },
  // Kimi
  "kimi-k2.7-code": { input: 0.95, output: 4.0 },
  "kimi-k3": { input: 3.0, output: 15.0 },
  "kimi-k2.6": { input: 0.95, output: 4.0 },
  "kimi-k2.5": { input: 0.6, output: 3.0 },
  // Qwen
  "qwen3.7-max": { input: 2.5, output: 7.5 },
  "qwen3.7-plus": { input: 0.4, output: 1.6 },
  "qwen3.6-plus": { input: 0.5, output: 3.0 },
  "qwen3.5-plus": { input: 0.2, output: 1.2 },
  "qwen3.8-max": { input: 2.5, output: 7.5 },
  // DeepSeek (off-peak)
  "deepseek-v4-pro": { input: 0.66, output: 1.98 },
  "deepseek-v4-flash": { input: 0.22, output: 0.66 },
  // Claude
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  // Gemini
  "gemini-3.7-flash": { input: 1.5, output: 7.5 },
  "gemini-3.6-flash": { input: 1.5, output: 7.5 },
  "gemini-3.5-flash": { input: 1.5, output: 9.0 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
  "gemini-3.1-pro": { input: 2, output: 12 },
  "gemini-3-flash": { input: 0.5, output: 3.0 },
  // Grok
  "grok-4.6": { input: 2, output: 6 },
  "grok-4.5": { input: 2, output: 6 },
  "grok-build-0.1": { input: 1, output: 2 },
  // Muse Spark
  "muse-spark-1.2": { input: 1.25, output: 4.25 },
  // GPT-5.x (Zen pricing; Go may differ)
  "gpt-5.6-sol": { input: 5, output: 30 },
  "gpt-5.6-terra": { input: 2, output: 12 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2 },
  "gpt-5.5": { input: 5, output: 30 },
  "gpt-5.5-pro": { input: 30, output: 180 },
  "gpt-5.4": { input: 2.5, output: 15 },
  "gpt-5.4-pro": { input: 30, output: 180 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25 },
  "gpt-5.3-codex": { input: 1.75, output: 14 },
  "gpt-5.3-codex-spark": { input: 1.75, output: 14 },
  "gpt-5.2": { input: 1.75, output: 14 },
  "gpt-5.2-codex": { input: 1.75, output: 14 },
  "gpt-5.1": { input: 1.07, output: 8.5 },
  "gpt-5.1-codex": { input: 1.07, output: 8.5 },
  "gpt-5.1-codex-max": { input: 1.25, output: 10 },
  "gpt-5.1-codex-mini": { input: 0.25, output: 2 },
  "gpt-5": { input: 1.07, output: 8.5 },
  "gpt-5-codex": { input: 1.07, output: 8.5 },
  "gpt-5-nano": { input: 0.05, output: 0.4 },
};

/** Provider prefixes stripped before a price lookup. */
const PROVIDER_PREFIXES = ["opencode-go/", "opencode/", "openai/", "anthropic/"];

/** Normalize a model id to its bare form for the price table lookup. */
export function normalizeModelId(model: string): string {
  let id = model.trim();
  for (const prefix of PROVIDER_PREFIXES) {
    if (id.startsWith(prefix)) {
      id = id.slice(prefix.length);
      break;
    }
  }
  // Strip a vendor path like qwen/qwen3.5-9b -> qwen3.5-9b (keeps bare ids).
  const parts = id.split("/");
  return parts[parts.length - 1];
}

/** Resolve the price for a model id. Overrides win, then the builtin table. */
export function resolvePrice(
  model: string,
  config?: PricingConfig,
): ModelPrice | undefined {
  if (!config?.enabled) return undefined;
  const bare = normalizeModelId(model);
  const overrides = config.overrides ?? {};
  const direct = overrides[model] ?? overrides[bare];
  if (direct) return direct;
  return ZEN_PRICES[bare];
}

/** Кеш-часть usage для расчёта стоимости (cached/uncached уже разделены). */
export interface CacheCostInput {
  cachedTokens?: number;
  cacheWriteTokens?: number;
}

export interface CostResult {
  /** Стоимость вызова в USD с учётом кеша. */
  cost: number;
  /** Сколько сэкономлено на cache read относительно полной input-цены. */
  saved: number;
}

/**
 * Считает стоимость и экономию вызова. `promptTokens` — суммарные prompt-токены
 * (cached + uncached); кешированная часть тарифицируется по `cachedInput`, а
 * запись в кеш — по `cacheWrite`. Возвращает undefined без известной цены.
 */
export function calculateCostDetailed(
  model: string,
  promptTokens: number,
  completionTokens: number,
  config?: PricingConfig,
  cache?: CacheCostInput,
): CostResult | undefined {
  const price = resolvePrice(model, config);
  if (!price) return undefined;
  const cached = Math.max(0, cache?.cachedTokens ?? 0);
  const write = Math.max(0, cache?.cacheWriteTokens ?? 0);
  const uncached = Math.max(0, promptTokens - cached);
  const cachedRate = price.cachedInput ?? price.input;
  const writeRate = price.cacheWrite ?? 0;

  const cost =
    (uncached / 1_000_000) * price.input +
    (cached / 1_000_000) * cachedRate +
    (write / 1_000_000) * writeRate +
    (completionTokens / 1_000_000) * price.output;
  const saved = (cached / 1_000_000) * (price.input - cachedRate);
  return { cost, saved };
}

/**
 * Стоимость вызова в USD (обёртка над `calculateCostDetailed`). Возвращает
 * undefined, когда цена модели неизвестна.
 */
export function calculateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
  config?: PricingConfig,
  cache?: CacheCostInput,
): number | undefined {
  return calculateCostDetailed(model, promptTokens, completionTokens, config, cache)?.cost;
}

/** Format a USD cost for display. Zero and very small amounts stay readable. */
export function formatCost(cost: number): string {
  if (cost === 0) return "$0.00";
  if (cost >= 0.01) return `$${cost.toFixed(2)}`;
  if (cost >= 0.0001) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(6)}`;
}