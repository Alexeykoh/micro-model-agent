// Пер-экспертный LLM-провайдер: `experts[tag].model` исполняется на
// выделенном провайдере, когда модель эксперта отличается от активной.
// Провайдер строится на активном провайдере агента; при совпадении модели
// переиспользуется общий.
import type { AppConfig } from "../../config/types";
import type { LLMProvider } from "../../llm/provider";
import type { Logger } from "../../logger/app-logger";
import { buildManagedProvider } from "../providers/managed";

/**
 * Резолвит провайдера для эксперта.
 * - модель пустая или совпадает с активной → общий `activeProvider`;
 * - иначе — управляемый провайдер на активном провайдере с моделью эксперта;
 * - ошибка сборки → warn + активный провайдер (fail-open, как у критика).
 *
 * `getSessionId` обязателен по сути: без него выделенный провайдер не шлёт
 * `x-opencode-session`, а OpenCode Go/Zen отвечают 400 MissingSessionID на каждый
 * запрос эксперта (сабтаски и субагенты с `expert_tag` умирали целиком).
 */
export function resolveExpertProvider(
  config: AppConfig,
  expertModel: string | undefined,
  activeProvider: LLMProvider,
  logger?: Logger,
  getSessionId?: () => string | undefined,
): LLMProvider {
  const model = expertModel?.trim();
  if (!model || model === config.model) return activeProvider;
  try {
    return buildManagedProvider(config.provider, model, {
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
