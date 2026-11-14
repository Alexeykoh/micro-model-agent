/**
 * Мост `OutputBus` → SSE демона (split W10): варнинги и ошибки шины должны
 * доезжать до тонкого клиента, как в локальном вебе (`log-forward.ts`).
 *
 * Событие привязывается к сессии по `sessionId` шины: мульти-сессионный демон
 * не имеет «активной» вкладки, поэтому событие без владельца не рассылается.
 */
import { defaultOutputBus } from "../../../output";
import type { OutputBus } from "../../../output/bus";
import type { OutputEvent, OutputLevel } from "../../../output/types";
import { redactContextSecrets } from "../../../core/api";
import type { AgentServiceState } from "../state";
import { emitSessionEvent } from "./emit";

/** Уровни, которые видит пользователь; `debug` — терминальный шум. */
const FORWARDED: readonly OutputLevel[] = ["info", "warn", "error"];

/** Подписывает демон на шину; возвращает отписку (звать в `stop`). */
export function installServiceLogForwarding(
  s: AgentServiceState,
  bus: OutputBus = defaultOutputBus,
): () => void {
  return bus.subscribe((ev: OutputEvent) => {
    if (!FORWARDED.includes(ev.level)) return;
    const sessionId = ev.sessionId;
    if (!sessionId || !s.deps.sessionManager?.get(sessionId)) return;
    emitSessionEvent(s, sessionId, "log", {
      level: ev.level,
      source: ev.source,
      text: redactContextSecrets(ev.text),
      diagnostic: ev.data?.diagnostic === true,
    });
  });
}
