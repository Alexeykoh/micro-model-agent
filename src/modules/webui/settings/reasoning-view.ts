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
  /** false — активный эндпоинт не отвечает; undefined — статус неизвестен. */
  reachable?: boolean;
}

/** Признанные имена усилий эндпоинтов (зеркало EFFORT_OPTION из provider-context). */
const EFFORT_NAMES = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Список уровней для селектора: только то, что объявил эндпоинт (INV-R7),
 * своими именами и в серверном порядке. `none` — выключатель (когда он
 * вообще выразим: off-switch или тег/kwarg). Никаких канонических алиасов
 * (`xhigh → high`): показываем ровно то, что отдаёт сервер. Не-усилия
 * (`off`/`on` из LM Studio) усилий не несут — только выключатель.
 */
function visibleLevels(
  declared: string[] | undefined,
  strategy: ReasoningStrategy,
  reasoningOff: boolean,
): string[] | null {
  if (declared === undefined) return null;
  const canOff = reasoningOff || strategy === "prompt-tag" || strategy === "template-kwarg";
  const offered: string[] = [];
  if (canOff) offered.push("none");
  for (const value of declared) {
    if (EFFORT_NAMES.has(value) && !offered.includes(value)) offered.push(value);
  }
  // Пустой массив — declared but no granular effort levels (LM Studio off/on).
  if (offered.length === 0) return canOff ? ["none"] : [];
  return offered;
}

/**
 * Строит вид из живого конфига (entries побеждают легаси-плоские поля).
 * Механизм берётся тот, с которым реально работал агент (INV-R8): bootstrap
 * запоминает его в `probe.ts` до старта UI. Пока агент не резолвил (юнит-тесты,
 * самый первый кадр), падаем на пресет — стратегия не выдумывается.
 */
export function buildReasoningView(
  config: AppConfig,
  probe?: { reachable?: boolean },
): ReasoningView {
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
  const unreachable = probe?.reachable === false;
  return {
    strategy: unreachable ? "none" : strategy,
    reasoningOff,
    supported: unreachable ? false : (cached === undefined ? null : cached),
    mode: config.reasoning?.mode ?? "auto",
    levels: unreachable ? null : visibleLevels(
      remembered?.levels ?? preset.reasoningLevels,
      strategy,
      reasoningOff,
    ),
    reachable: probe?.reachable,
  };
}
