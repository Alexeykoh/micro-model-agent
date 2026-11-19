// Reasoning-резолв активной записи провайдера (INV-R2/R7): стратегия и
// объявленные уровни effort — через единый резолвер capabilities.
import type { ProviderConfig, ReasoningStrategy, ModelCapabilities } from "../../config/types";
import { BUILTIN_PROVIDERS } from "./presets";
import { resolveModelCapabilities } from "./capabilities";
import { activeProviderEndpoint } from "./endpoint";

type ProviderRef = Pick<ProviderConfig, "entries" | "active" | "type" | "baseUrl" | "apiKey">;

function resolveCaps(config?: ProviderRef, probe?: ModelCapabilities, override?: ModelCapabilities) {
  const type = activeProviderEndpoint(config).type;
  const spec = BUILTIN_PROVIDERS.find((p) => p.type === type);
  return resolveModelCapabilities(spec?.capabilities, probe, override);
}

/**
 * Полный резолв capabilities reasoning АКТИВНОЙ записи (тот же трёхслойный
 * приоритет, что у стратегии/уровней). Нужен там, где требуется и `reasoningOff`
 * (сверка UI с применённым резолвом), а не только стратегия.
 */
export function reasoningCapsForProvider(
  config?: ProviderRef,
  probe?: ModelCapabilities,
  override?: ModelCapabilities,
): ModelCapabilities {
  return resolveCaps(config, probe, override);
}

/**
 * Стратегия reasoning АКТИВНОЙ записи провайдера, трёхслойно: оверрайд модели
 * → проба → пресет. Неизвестный тип → "none".
 */
export function reasoningStrategyForProvider(
  config?: ProviderRef,
  probe?: ModelCapabilities,
  override?: ModelCapabilities,
): ReasoningStrategy {
  return resolveCaps(config, probe, override).reasoningStrategy ?? "none";
}

/**
 * Объявленные уровни effort АКТИВНОЙ записи провайдера (тот же резолв, что и
 * стратегия). Нужны auto-политике и селектору, чтобы не показывать и не просить
 * уровней, которых сервер не отдаёт. `undefined` = сервер ничего не объявил.
 */
export function reasoningLevelsForProvider(
  config?: ProviderRef,
  probe?: ModelCapabilities,
  override?: ModelCapabilities,
): string[] | undefined {
  return resolveCaps(config, probe, override).reasoningLevels;
}
