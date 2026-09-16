// src/modules/providers/factory.ts
import type { AppConfig } from "../../config/types";
import type { Logger } from "../../logger/app-logger";
import type { LLMProvider } from "../../llm/provider";
import { ProviderManager } from "./manager";
import { FallbackProvider } from "./fallback";

export interface BuiltProvider {
  manager: ProviderManager;
  /** Active provider, transparently wrapped in FallbackProvider when enabled. */
  provider: LLMProvider;
}

/**
 * Shared factory for building the ACTIVE provider from a config, used by both
 * bootstrap and Agent.setProvider/reconfigure. Previously the three
 * construction sites drifted — bootstrap wrapped the manager in
 * FallbackProvider when `fallback && entries > 1`, but a hot-swap
 * (setProvider) rebuilt a bare manager and silently dropped failover (B4).
 * The wrapper reads `manager.active` live, so switching the manager after
 * build keeps the failover active.
 */
export function buildActiveProvider(
  config: AppConfig,
  logger?: Logger,
  opts?: { getSessionId?: () => string | undefined },
): BuiltProvider {
  const manager = new ProviderManager(config.provider, {
    contextWindow: config.contextWindow,
    retry: config.retry,
    rateLimits: config.security?.rateLimits,
    getSessionId: opts?.getSessionId,
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