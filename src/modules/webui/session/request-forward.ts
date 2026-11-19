/**
 * Мост «снимок LLM-запроса → SSE + session.jsonl» (U20).
 *
 * Снимок рождается в `openai-compat` (после DLP-проекции, до сети) и
 * публикуется через `subscribeRequestSnapshots`. Здесь он:
 * 1) пишется в `session.jsonl` раннера-владельца (`llm_request`) — для истории
 *    и бэкфилла Trace после перезагрузки;
 * 2) переиздаётся SSE-событием `llm_request` — для живого поп-апа «Запрос».
 *
 * Fail-open: снимок не имеет права уронить ход (INV-15).
 */
import {
  subscribeRequestSnapshots,
  type LlmRequestSnapshot,
} from "../../../llm/request-snapshot";
import type { SessionLogEntry } from "../../session/store";
import { broadcast, type SseTransport } from "../state";
import type { RunPool } from "../../../runtime/run-pool/run-pool";

/** Минимальное состояние, нужное мосту (тесты дают заглушку). */
export interface RequestForwardState extends SseTransport {
  pool?: RunPool;
}

/** Записать снимок в журнал раннера-владельца; без раннера — только SSE. */
function persistSnapshot(
  state: RequestForwardState,
  sessionId: string,
  request: LlmRequestSnapshot,
): void {
  try {
    const runner = state.pool?.getRunner(sessionId);
    const entry: SessionLogEntry = {
      ts: request.ts,
      type: "llm_request",
      source: "core",
      llmRequest: request,
    };
    runner?.sessionManager.appendLog(entry, sessionId);
  } catch {
    /* fail-open: журнал не имеет права уронить ход */
  }
}

/** Подписать webui на снимки запросов; возвращает отписку. */
export function installRequestForwarding(state: RequestForwardState): () => void {
  return subscribeRequestSnapshots((request) => {
    const sessionId = request.sessionId;
    if (sessionId) persistSnapshot(state, sessionId, request);
    broadcast(
      {
        type: "llm_request",
        ts: Date.parse(request.ts) || Date.now(),
        ...(sessionId ? { sessionId } : {}),
        request,
      },
      state,
    );
  });
}
