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
  /** Уровни, реально доступные у провайдера+модели (INV-R7); null = не объявлены. */
  levels: string[] | null;
}

/** Канонические уровни харнесса в порядке возрастания (без auto/default). */
const CANONICAL_ORDER = ["none", "low", "medium", "high", "max"];
/** Нестандартные значения эндпоинта → канонический уровень харнесса. */
const LEVEL_ALIASES: Record<string, string> = { xhigh: "high" };

/**
 * Список уровней для селектора: только то, что объявил эндпоинт (INV-R7).
 * `none` показываем, когда выключение вообще выразимо (off-switch или тег/kwarg).
 */
function visibleLevels(
  declared: string[] | undefined,
  strategy: ReasoningStrategy,
  reasoningOff: boolean,
): string[] | null {
  if (declared === undefined) return null;
  const canOff = reasoningOff || strategy === "prompt-tag" || strategy === "template-kwarg";
  const offered = new Set<string>();
  if (canOff) offered.add("none");
  for (const value of declared) offered.add(LEVEL_ALIASES[value] ?? value);
  // Пустой массив — declared but no granular effort levels (LM Studio off/on).
  if (offered.size === 0) return canOff ? ["none"] : [];
  return CANONICAL_ORDER.filter((lvl) => offered.has(lvl));
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
    levels: visibleLevels(
      remembered?.levels ?? preset.reasoningLevels,
      strategy,
      reasoningOff,
    ),
  };
}
