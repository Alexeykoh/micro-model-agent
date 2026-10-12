// Единый билдер «управляемого» провайдера через ProviderManager: per-entry
// contextWindow/retry/rateLimits + failover. Используется критиком и
// пер-экспертными провайдерами (отдельная модель на эксперта).
import type { LLMProvider } from "../../llm/provider";
import type { ProviderConfig, RateLimitConfig, RetryConfig } from "../../config/types";
import type { Logger } from "../../logger/app-logger";
import { ProviderManager } from "./manager";
import { FallbackProvider } from "./fallback";

/** Запасное окно контекста, если ни запись провайдера, ни конфиг его не задают. */
export const DEFAULT_MANAGED_CONTEXT_WINDOW = 32768;

/** Фолбэк base URL, когда запись провайдера его не задаёт. */
const DEFAULT_MANAGED_BASE_URL = "http://localhost:1234/v1";

/** Опции сборки управляемого провайдера. */
export interface ManagedProviderOptions {
  /** Окно контекста (дефолт 32768; запись провайдера перекрывает). */
  contextWindow?: number;
  retry?: RetryConfig;
  rateLimits?: RateLimitConfig;
  getSessionId?: () => string | undefined;
  logger?: Logger;
  /** Метка для сообщения failover (напр. "orchestrator"/"critic"/"expert"). */
  label?: string;
}

/**
 * Строит провайдер на конкретной модели через ProviderManager (учитывает
 * entries[]/легаси `{type,baseUrl,apiKey}`, per-entry contextWindow/retry/
 * rateLimits и failover-записи). Ничего не кеширует — вызывающий решает,
 * когда пересобирать.
 */
export function buildManagedProvider(
  providerCfg: ProviderConfig,
  model: string,
  opts: ManagedProviderOptions = {},
): LLMProvider {
  const manager = new ProviderManager(
    { ...providerCfg, baseUrl: providerCfg.baseUrl || DEFAULT_MANAGED_BASE_URL },
    {
      contextWindow: opts.contextWindow ?? DEFAULT_MANAGED_CONTEXT_WINDOW,
      retry: opts.retry,
      rateLimits: opts.rateLimits,
      getSessionId: opts.getSessionId,
      logger: opts.logger,
    },
  );
  manager.setModel(model);

  let provider: LLMProvider = manager.active;
  if (providerCfg.fallback && manager.listNames().length > 1) {
    const label = opts.label ? `${opts.label} ` : "";
    provider = new FallbackProvider(manager, (from, to, error) => {
      opts.logger?.warn(
        `${label}provider failover: ${from} -> ${to} (${error.message.slice(0, 120)})`,
      );
    });
  }
  return provider;
}
