/** Журнал исходящих LLM-запросов в CLI/one-shot (без webui-моста). */
import { hasSnapshotPersistenceOwner, subscribeRequestSnapshots } from "../../llm/request-snapshot";
import type { SessionManager } from "../../modules/session/manager";
import type { SessionLogger } from "../session-logger";

/**
 * Подписывает снимки на текущий ход. Если webui уже пишет `llm_request`,
 * ядро не дублирует запись — SSE при этом остаётся в веб-мосте.
 */
export function installTurnRequestLog(
  slog: SessionLogger,
  sessions: SessionManager | undefined,
): () => void {
  if (hasSnapshotPersistenceOwner() || !sessions) return () => {};
  return subscribeRequestSnapshots((request) => {
    const active = sessions.getActive?.();
    if (!request.sessionId || !active || request.sessionId === active) slog.logLlmRequest(request);
  });
}
