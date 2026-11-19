/**
 * Самоисцеление capability-пробы холодной локальной модели (llama-swap).
 *
 * `/props?model=…&autoload=false` отвечает 409, пока модель не загружена, поэтому
 * стартовая проба знает только модальности из `/v1/models` и стратегия reasoning
 * остаётся из пресета. Когда модель позже загрузилась, нужно переспросить бэкенд
 * и обновить живой снимок (INV-R2/R8), иначе селектор вечно показывает auto/default.
 *
 * Вынесено отдельным файлом, чтобы `provider-probes.ts` не перерастал потолок
 * в 300 строк (правило 6 AGENTS.md).
 */
import type { AgentDeps, ProviderProbesBox } from "./deps";
import type { DiscoveredCapabilities } from "./provider-probes";
import type { AppConfig, ModelCapabilities, ReasoningStrategy } from "../../config/types";
import { activeProviderEndpoint } from "../../modules/providers/manager";
import { reasoningCapsForProvider } from "../../modules/providers/reasoning-resolve";
import { rememberReasoningMechanism } from "../../modules/reasoning/probe";
import { writeCachedCapabilities } from "../../modules/providers/capabilities-cache";

/** Не чаще одного повтора за это время — `/api/models` читается часто. */
const REPROBE_COOLDOWN_MS = 30_000;

/** Узкий вид зависимостей, достаточный для публикации reasoning-снимка. */
export type CapsDeps = Pick<
  AgentDeps,
  "config" | "capabilitiesProbeRef" | "reasoningStrategy" | "reasoningLevels"
>;

/** Шов для тестов: та же сигнатура, что у `discoverCapabilities`. */
export type DiscoverFn = (
  endpoint: { baseUrl: string; apiKey?: string; type: string },
  model: string,
  opts?: { timeoutMs?: number; probeOffSwitch?: boolean },
) => Promise<DiscoveredCapabilities>;

/** Типы, у которых локальная `/props`-проба имеет смысл (зеркало provider-context). */
function localProbeType(type?: string): boolean {
  return type === undefined || type === "openai-compat" || type === "lmstudio";
}

/**
 * Отмечает, что у reachable-эндпоинта не удалось узнать механизм reasoning.
 * Флаг снимается, как только проба принесла настоящее объявление — либо
 * из дискового кэша, либо из живого `/props`.
 */
export function markReasoningReprobe(
  ref: ProviderProbesBox | undefined,
  discovered: DiscoveredCapabilities,
  providerType?: string,
): void {
  if (!ref) return;
  const hasReasoning = discovered.capabilities?.reasoningStrategy !== undefined;
  ref.needsReasoningReprobe =
    discovered.reachable === true && localProbeType(providerType) && !hasReasoning;
}

/**
 * Публикует резолв reasoning во все живые точки: deps агента, общий бокс проб
 * и память пары `baseUrl|model`. Иначе UI покажет один механизм, а запросы
 * уйдут с другим (INV-R8).
 */
export function publishReasoningCaps(deps: CapsDeps, config: AppConfig): void {
  const ref = deps.capabilitiesProbeRef;
  const reachable = ref?.reachable !== false;
  const override = config.modelCapabilities?.[config.model];
  const caps: ModelCapabilities = reachable
    ? reasoningCapsForProvider(config.provider, ref?.probe, override)
    : {};
  const strategy: ReasoningStrategy = reachable ? caps.reasoningStrategy ?? "none" : "none";
  const levels = reachable ? caps.reasoningLevels : undefined;
  const reasoningOff = reachable && caps.reasoningOff === true;

  deps.reasoningStrategy = strategy;
  deps.reasoningLevels = levels;
  const endpoint = activeProviderEndpoint(config.provider);
  rememberReasoningMechanism(endpoint.baseUrl, config.model, { strategy, reasoningOff, levels });
  if (ref) {
    ref.reasoningStrategy = strategy;
    ref.reasoningLevels = levels;
    ref.reasoningOff = reasoningOff;
  }
}

/**
 * Повторяет discovery, только если за ним числится незавершённая проба.
 * Возвращает true, когда уровень рассуждений наконец получен и снимок обновлён.
 * При холодной модели флаг остаётся — следующий запрос попробует ещё раз.
 */
export async function retryReasoningDiscovery(
  deps: CapsDeps,
  config: AppConfig,
  discover: DiscoverFn,
): Promise<boolean> {
  const ref = deps.capabilitiesProbeRef;
  if (!ref?.needsReasoningReprobe || ref.reachable !== true || ref.reasoningReprobeInflight) {
    return false;
  }
  const now = Date.now();
  if (ref.lastReasoningReprobeAt && now - ref.lastReasoningReprobeAt < REPROBE_COOLDOWN_MS) {
    return false;
  }
  ref.lastReasoningReprobeAt = now;
  ref.reasoningReprobeInflight = true;
  try {
    const endpoint = activeProviderEndpoint(config.provider);
    const discovered = await discover(endpoint, config.model, {
      probeOffSwitch: config.reasoning?.mode !== "none",
    });
    if (discovered.capabilities?.reasoningStrategy === undefined) return false;
    // Не стираем уже известные возможности (vision/tools), пришедшие из /models.
    ref.probe = { ...(ref.probe ?? {}), ...discovered.capabilities };
    writeCachedCapabilities(endpoint.baseUrl, config.model, ref.probe);
    ref.needsReasoningReprobe = false;
    publishReasoningCaps(deps, config);
    return true;
  } catch {
    // Fail-open: transient-сбой не отменяет флаг, попробуем на следующем чтении.
    return false;
  } finally {
    ref.reasoningReprobeInflight = false;
  }
}
