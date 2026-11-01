// Пер-экспертный LLM-провайдер: `experts[tag].model` (+ необязательный
// `experts[tag].provider`) исполняется на выделенном провайдере, когда модель
// эксперта отличается от активной. Провайдер строится на записи
// `provider.entries[]` эксперта (или на активном провайдере агента); при
// совпадении модели переиспользуется общий.
import type { AppConfig } from "../../config/types";
import type { LLMProvider } from "../../llm/provider";
import type { Logger } from "../../logger/app-logger";
import { buildManagedProvider } from "../providers/managed";
import { resolveProviderRef } from "../providers/resolve-ref";

/** Имя активной записи провайдера (лейбл важнее типа). */
function activeProviderName(config: AppConfig): string {
  return config.provider.active?.trim() || config.provider.type?.trim() || "";
}

/**
 * Резолвит провайдера для эксперта.
 * - модель пустая → общий `activeProvider` (а `provider` без модели — немая
 *   настройка: warn, INV-E1);
 * - модель совпадает с активной и провайдер не задан (или это активная
 *   запись) → общий `activeProvider`;
 * - иначе — управляемый провайдер на записи `provider` (или активном
 *   провайдере) с моделью эксперта;
 * - ошибка сборки → warn + активный провайдер (fail-open, как у критика).
 *
 * `getSessionId` обязателен по сути: без него выделенный провайдер не шлёт
 * `x-opencode-session`, а OpenCode Go/Zen отвечают 400 MissingSessionID на каждый
 * запрос эксперта (сабтаски и субагенты с `expert_tag` умирали целиком).
 */
export function resolveExpertProvider(
  config: AppConfig,
  expertModel: string | undefined,
  expertProvider: string | undefined,
  activeProvider: LLMProvider,
  logger?: Logger,
  getSessionId?: () => string | undefined,
): LLMProvider {
  const model = expertModel?.trim();
  const providerRef = expertProvider?.trim() ?? "";
  if (!model) {
    // Немая опция: провайдер без модели ни на что не влияет — предупреждаем,
    // иначе настройка выглядит рабочей, а эффекта ноль (контракт критика).
    if (providerRef) {
      logger?.warn(
        `expert provider "${providerRef}" is set without an expert model — provider ignored, using the active model`,
      );
    }
    return activeProvider;
  }
  const sameModel = model === config.model;
  const sameProvider = !providerRef || providerRef === activeProviderName(config);
  if (sameModel && sameProvider) return activeProvider;
  try {
    const providerCfg = resolveProviderRef(config, providerRef) ?? config.provider;
    return buildManagedProvider(providerCfg, model, {
      contextWindow: config.contextWindow,
      retry: config.retry,
      rateLimits: config.security?.rateLimits,
      getSessionId,
      logger,
      label: "expert",
    });
  } catch (err) {
    logger?.warn(
      `expert provider build failed for "${model}", using active provider: ${String((err as Error)?.message ?? err).slice(0, 160)}`,
    );
    return activeProvider;
  }
}
