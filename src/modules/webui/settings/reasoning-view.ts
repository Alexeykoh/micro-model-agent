// Read-проекция reasoning для ряда селекторов `mma web` (чистая, без секретов).
/**
 * Тот же паттерн, что `providers-view.ts`: выводится на запрос из живого
 * конфига, всегда свежая без reconfigure-обвязки — `state.config` алиасит
 * объект, мутируемый агентом.
 */
import type { AppConfig, ReasoningStrategy } from "../../../config/types";
import { activeProviderEndpoint } from "../../providers/manager";
import { BUILTIN_PROVIDERS } from "../../providers/presets";
import { resolveModelCapabilities } from "../../providers/capabilities";
import { getCachedProbeResult, cacheKey, getRememberedReasoningMechanism } from "../../reasoning/probe";

/** Поддержка reasoning активной пары провайдер+модель. */
export interface ReasoningView {
  /** Механика из трёхслойного резолвера (`none` = не поддерживается). */
  strategy: ReasoningStrategy;
  /** Эндпоинт объявил off-switch (нужен для ключа пробы и для честной метки). */
  reasoningOff: boolean;
  /**
   * Кешнутый вердикт пробы для «эндпоинт|модель|механизм»: `true` — механика
   * уважается, `false` — НЕ ПОДТВЕРЖДЕНО (не «игнорируется»), `null` — проба
   * для этой механики ещё не гонялась.
   */
  supported: boolean | null;
  /** Текущий `config.reasoning.mode` (дефолт `"auto"`). */
  mode: string;
}

/**
 * Строит вид из живого конфига (entries побеждают легаси-плоские поля).
 * Механизм берётся тот, с которым реально работал агент (INV-R8): bootstrap
 * запоминает его в `probe.ts` до старта UI. Пока агент не резолвил (юнит-тесты,
 * самый первый кадр), падаем на пресет — стратегия не выдумывается.
 */
export function buildReasoningView(config: AppConfig): ReasoningView {
  const endpoint = activeProviderEndpoint(config.provider);
  const override = config.modelCapabilities?.[config.model];
  const remembered = getRememberedReasoningMechanism(endpoint.baseUrl, config.model);
  const preset = resolveModelCapabilities(
    BUILTIN_PROVIDERS.find((p) => p.type === endpoint.type)?.capabilities,
    undefined,
    override,
  );
  const strategy = remembered?.strategy ?? preset.reasoningStrategy ?? "none";
  const reasoningOff = remembered?.reasoningOff ?? preset.reasoningOff === true;
  const cached = getCachedProbeResult(
    cacheKey(endpoint.baseUrl, config.model, strategy, reasoningOff),
  );
  return {
    strategy,
    reasoningOff,
    supported: cached === undefined ? null : cached,
    mode: config.reasoning?.mode ?? "auto",
  };
}
