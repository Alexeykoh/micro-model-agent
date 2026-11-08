/** Позднее применение резолвнутой context-probe (вынесено из provider-phase). */
import type { AppConfig } from "../../config/types";
import type { ContextProbeResult } from "../../llm/model-loader";
import type { SilentLogger } from "./state";

/**
 * Позднее применение резолвнутой context-probe. Проба приземляется фоном ПОСЛЕ
 * сборки ContextManager/провайдера под стартовое окно — одна запись значения в
 * `config` оставит бюджеты протухшими, поэтому нужен reconfigure (ресайз +
 * пересборка провайдера).
 *
 * Пропуск, когда применять нечего (`config` больше не несёт значение пробы —
 * совпало сразу или переопределено вручную) или ход уже был (ресайз посреди
 * истории ломает бюджеты). Не бросает никогда.
 */
export async function applyProbedContext(
  agent: Pick<
    { currentIteration: number; reconfigure(cfg: AppConfig): Promise<void> },
    "currentIteration" | "reconfigure"
  >,
  config: AppConfig,
  probe: ContextProbeResult,
  logger: SilentLogger,
  sessionManager?: { setEffectiveContext(contextWindow: number, model?: string): void },
): Promise<boolean> {
  if (config.contextWindow !== probe.actual) return false;
  if (agent.currentIteration !== 0) {
    logger.logSilent(
      "debug",
      `Context probe: keeping startup contextWindow ${config.contextWindow} — a turn already ran`,
    );
    return false;
  }
  try {
    await agent.reconfigure(config);
    // Мета сессии фиксирует окно из `SessionManager.create()` (стартовое
    // значение, ДО пробы). Наблюдалось: проба авто-подставила 262144 в живой
    // конфиг, а `session_start` и `meta.json` продолжали показывать 65536 —
    // расхождение не диагностировалось нигде. Синхронизируем явно (идемпотентно)
    // и проверяем результат.
    sessionManager?.setEffectiveContext(config.contextWindow, config.model);
    logger.logSilent(
      "info",
      `Context probe: applied provider context ${probe.actual} tokens (model "${probe.model}")`,
    );
    return true;
  } catch (e) {
    // INV-15: не удалось применить пробу контекста — конфиг и лог сессии
    // разойдутся, если это не записать.
    logger.logSilent(
      "warn",
      `Context probe apply FAILED: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}
