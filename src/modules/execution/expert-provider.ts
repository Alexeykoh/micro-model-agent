// Пер-экспертный LLM-провайдер MoE: `experts[tag].model` исполняется на
// выделенном провайдере, когда модель эксперта отличается от активной.
// Провайдер строится на активном провайдере агента (как `orchestrator.model`
// без `orchestrator.provider`); при совпадении модели переиспользуется общий.
import type { AppConfig } from "../../config/types";
import type { LLMProvider } from "../../llm/provider";
import type { Logger } from "../../logger/app-logger";
import { buildManagedProvider } from "../providers/managed";

/**
 * Резолвит провайдера для эксперта MoE.
 * - модель пустая или совпадает с активной → общий `activeProvider`;
 * - иначе — управляемый провайдер на активном провайдере с моделью эксперта;
 * - ошибка сборки → warn + активный провайдер (fail-open, как у критика).
 */
export function resolveExpertProvider(
  config: AppConfig,
  expertModel: string | undefined,
  activeProvider: LLMProvider,
  logger?: Logger,
): LLMProvider {
  const model = expertModel?.trim();
  if (!model || model === config.model) return activeProvider;
  try {
    return buildManagedProvider(config.provider, model, {
      contextWindow: config.contextWindow,
      retry: config.retry,
      rateLimits: config.security?.rateLimits,
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
