// Выбор LLM для критика: выделенный провайдер при critic.model, иначе общий.
import type { LLMProvider } from "../../llm/provider";
import type { AppConfig, CriticConfig } from "../../config/types";
import type { Logger } from "../../logger/app-logger";
import { buildManagedProvider } from "../providers/managed";
import { resolveProviderRef } from "../providers/resolve-ref";

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
  // `provider` может быть объектом ProviderConfig или именем записи
  // `provider.entries[]` (UI отдаёт выпадающим списком).
  const hasProviderRef =
    typeof critic?.provider === "string"
      ? critic.provider.trim().length > 0
      : !!critic?.provider && Object.keys(critic.provider).length > 0;
  if (!model) {
    // Немая опция: провайдер без модели ни на что не влияет (поведение v1) —
    // предупреждаем, иначе настройка выглядит рабочей, а эффекта ноль.
    if (hasProviderRef) {
      deps?.logger?.warn("critic.provider is set without critic.model — provider ignored, using active provider");
    }
    return defaultProvider;
  }
  try {
    const providerCfg = resolveProviderRef(config, critic?.provider) ?? {
      type: "openai-compat",
      baseUrl: DEFAULT_CRITIC_BASE_URL,
    };
    return buildManagedProvider(providerCfg, model, {
      contextWindow: config.contextWindow ?? DEFAULT_CRITIC_CONTEXT_WINDOW,
      retry: config.retry,
      rateLimits: config.security?.rateLimits,
      getSessionId: deps?.getSessionId,
      logger: deps?.logger,
      label: "critic",
    });
  } catch (err) {
    deps?.logger?.warn(
      `critic provider override failed, using active provider: ${String((err as Error)?.message ?? err).slice(0, 160)}`,
    );
    return defaultProvider;
  }
}
