// Read-проекция reasoning для ряда селекторов `mma web` (чистая, без секретов).
/**
 * Тот же паттерн, что `providers-view.ts`: выводится на запрос из живого
 * конфига, всегда свежая без reconfigure-обвязки — `state.config` алиасит
 * объект, мутируемый агентом.
 */
import type { AppConfig, ReasoningStrategy } from "../../config/types";
import { BUILTIN_PROVIDERS } from "../providers/presets";
import { activeProviderEndpoint } from "../providers/manager";
import { getCachedProbeResult } from "../reasoning/probe";

/** Поддержка reasoning активной пары провайдер+модель. */
export interface ReasoningView {
  /** Механика из пресета активного провайдера (`none` = не поддерживается). */
  strategy: ReasoningStrategy;
  /**
   * Кешнутый вердикт проба для `baseUrl|model`: `true` — механика уважается,
   * `false` — молча игнорируется, `null` — проб для пары ещё не гонялся.
   */
  supported: boolean | null;
  /** Текущий `config.reasoning.mode` (дефолт `"auto"`). */
  mode: string;
}

/** Строит вид из живого конфига (entries побеждают легаси-плоские поля). */
export function buildReasoningView(config: AppConfig): ReasoningView {
  const endpoint = activeProviderEndpoint(config.provider);
  const spec = BUILTIN_PROVIDERS.find((p) => p.type === endpoint.type);
  const strategy = spec?.capabilities.reasoningStrategy ?? "none";
  const cached = getCachedProbeResult(`${endpoint.baseUrl}|${config.model}`);
  return {
    strategy,
    supported: cached === undefined ? null : cached,
    mode: config.reasoning?.mode ?? "auto",
  };
}
