import type { LLMProvider } from "../../llm/provider";
import type { AppConfig, CriticConfig } from "../../config/types";
import type { Logger } from "../../logger/app-logger";
import { ProviderManager } from "../providers/manager";
import { FallbackProvider } from "../providers/fallback";

const DEFAULT_CRITIC_BASE_URL = "http://localhost:1234/v1";

/** Fallback context window when neither the provider entry nor the config sets one. */
const DEFAULT_CRITIC_CONTEXT_WINDOW = 32768;

export interface CriticProviderDeps {
  logger?: Logger;
  getSessionId?: () => string | undefined;
}

/**
 * Resolve which LLM serves the critic (Phase 2). Mirrors OrchestratorClient:
 * a managed provider is built through ProviderManager (per-entry
 * contextWindow/retry/rateLimits, failover) ONLY when `critic.model` is set;
 * otherwise the critic shares the active provider (v1 behavior). A
 * `critic.provider` without a model keeps v1 behavior.
 *
 * Fail-open: a broken override warns and falls back to the active provider —
 * a misconfigured critic must never silently disable verification.
 */
export function buildCriticProvider(
  critic: CriticConfig | undefined,
  config: AppConfig,
  defaultProvider: LLMProvider,
  deps?: CriticProviderDeps,
): LLMProvider {
  const model = critic?.model?.trim();
  if (!model) return defaultProvider;
  try {
    const providerCfg = critic?.provider ?? {
      type: "openai-compat",
      baseUrl: DEFAULT_CRITIC_BASE_URL,
    };
    const manager = new ProviderManager(
      { ...providerCfg, baseUrl: providerCfg.baseUrl || DEFAULT_CRITIC_BASE_URL },
      {
        contextWindow: config.contextWindow ?? DEFAULT_CRITIC_CONTEXT_WINDOW,
        retry: config.retry,
        rateLimits: config.security?.rateLimits,
        getSessionId: deps?.getSessionId,
        logger: deps?.logger,
      },
    );
    manager.setModel(model);

    let provider: LLMProvider = manager.active;
    if (providerCfg.fallback && manager.listNames().length > 1) {
      provider = new FallbackProvider(manager, (from, to, error) => {
        deps?.logger?.warn(
          `critic provider failover: ${from} -> ${to} (${error.message.slice(0, 120)})`,
        );
      });
    }
    return provider;
  } catch (err) {
    deps?.logger?.warn(
      `critic provider override failed, using active provider: ${String((err as Error)?.message ?? err).slice(0, 160)}`,
    );
    return defaultProvider;
  }
}
