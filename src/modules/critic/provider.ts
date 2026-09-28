// Выбор LLM для критика: выделенный провайдер при critic.model, иначе общий.
import type { LLMProvider } from "../../llm/provider";
import type { AppConfig, CriticConfig } from "../../config/types";
import type { Logger } from "../../logger/app-logger";
import { ProviderManager } from "../providers/manager";
import { FallbackProvider } from "../providers/fallback";

const DEFAULT_CRITIC_BASE_URL = "http://localhost:1234/v1";

/** Окно контекста, если ни запись провайдера, ни конфиг его не задали. */
const DEFAULT_CRITIC_CONTEXT_WINDOW = 32768;

/** Зависимости builder'а critic-провайдера: логгер и id сессии. */
export interface CriticProviderDeps {
  logger?: Logger;
  getSessionId?: () => string | undefined;
}

/**
 * Резолвит LLM для критика (Phase 2). Зеркалит OrchestratorClient:
 * управляемый провайдер строится через ProviderManager (per-entry
 * contextWindow/retry/rateLimits, failover) ТОЛЬКО если задан `critic.model`;
 * иначе критик делит активный провайдер (поведение v1). `critic.provider`
 * без модели сохраняет поведение v1.
 *
 * Fail-open: битый оверрайд предупреждает и откатывается к активному
 * провайдеру — неверно настроенный критик не должен молча отключать проверку.
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
