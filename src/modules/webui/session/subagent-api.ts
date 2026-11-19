// `GET /api/sessions/:id/subagents` — снимки прогонов субагентов сессии.
//
// Прогоны живут в памяти процесса (`SubagentRunStore`), а не в
// `session.jsonl`: субагент — не сессия. Клиент открывает вкладку прогона по
// `parentToolCallId` строки ленты (или по `runId` из SSE). Auth и same-origin —
// выше в `server.ts`; чужой/неизвестный id — 404 (INV-D6-подобная непрозрачность).
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../util";
import type { SessionStore } from "../state";

/** `GET /api/sessions/:id/subagents[?toolCallId=<id>]`. */
export function handleSubagentRunsGet(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  s: SessionStore,
): void {  if (!s.sessionManager) {
    sendJson(res, 503, { error: "sessions_unavailable" });
    return;
  }
  if (!id || !s.sessionManager.get(id)) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  let toolCallId: string | undefined;
  try {
    const q = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("toolCallId");
    if (q) toolCallId = q;
  } catch {
    /* битый URL — отдаём все прогоны сессии */
  }
  sendJson(res, 200, { runs: s.subagentRuns.list(id, toolCallId) });
}

/** `POST /api/sessions/:id/subagents/:runId/interrupt` — остановить прогон. */
export function handleSubagentInterrupt(
  res: ServerResponse,
  id: string,
  runId: string,
  s: SessionStore,
): void {
  if (!s.sessionManager) {
    sendJson(res, 503, { error: "sessions_unavailable" });
    return;
  }
  if (!id || !s.sessionManager.get(id)) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  const status = s.subagentRuns.interrupt(id, runId);
  if (status === "not_found") {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  if (status === "not_running") {
    sendJson(res, 409, { error: "not_running" });
    return;
  }
  sendJson(res, 200, { ok: true });
}
