// Сборка АКТИВНОГО провайдера из конфига (bootstrap и hot-swap — один путь).
// src/modules/providers/factory.ts
import type { AppConfig, ModelCapabilities } from "../../config/types";
import type { Logger } from "../../logger/app-logger";
import type { LLMProvider } from "../../llm/provider";
import { ProviderManager } from "./manager";
import { FallbackProvider } from "./fallback";
import { sharedRateLimiter } from "../../llm/shared-rate-limiter";

export interface BuiltProvider {
  manager: ProviderManager;
  /** Активный провайдер, при включённом fallback прозрачно обёрнут в FallbackProvider. */
  provider: LLMProvider;
}

/**
 * Общая фабрика АКТИВНОГО провайдера из конфига — для bootstrap и
 * Agent.setProvider/reconfigure. Раньше три места сборки дрейфовали: bootstrap
 * оборачивал менеджер в FallbackProvider при `fallback && entries > 1`, а
 * hot-swap (setProvider) пересобирал голый менеджер и молча ронял failover (B4).
 * Обёртка читает `manager.active` живьём, так что переключение менеджера после
 * сборки failover сохраняет.
 */
/** Собрать активный провайдер (+ failover-обёртка при entries > 1). */
export function buildActiveProvider(
  config: AppConfig,
  logger?: Logger,
  opts?: { getSessionId?: () => string | undefined; probeCapabilities?: () => ModelCapabilities | undefined },
): BuiltProvider {
  const manager = new ProviderManager(config.provider, {
    contextWindow: config.contextWindow,
    retry: config.retry,
    rateLimits: config.security?.rateLimits,
    // Лимитер запросов ОБЩИЙ на процесс: иначе каждый раннер сессии получает
    // свой, и фактический поток к провайдеру в N раз выше заявленного.
    sharedLimiter: sharedRateLimiter(config.security?.rateLimits),
    getSessionId: opts?.getSessionId,
    modelCapabilities: config.modelCapabilities,
    probeCapabilities: opts?.probeCapabilities,
    logger,
  });
  manager.setModel(config.model);

  let provider: LLMProvider = manager.active;
  if (config.provider.fallback && manager.listNames().length > 1) {
    provider = new FallbackProvider(manager, (from, to, error) => {
      logger?.warn(`provider failover: ${from} -> ${to} (${error.message.slice(0, 120)})`);
    });
  }
  return { manager, provider };
}