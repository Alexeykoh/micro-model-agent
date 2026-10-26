// `GET /api/sessions/:id/system-prompt` — текст и состав системного промпта.
// Раннер сессии живёт в пуле; если сессия ещё не ходила, отдаём available:false
// (промпт не строим ради GET — это создало бы агента как побочный эффект).
import type { ServerResponse } from "node:http";
import { sendJson } from "../util";
import type { RunPool } from "./session-pool";

export function handleSystemPromptGet(res: ServerResponse, id: string, pool: RunPool): void {
  const runner = pool.getRunner(id);
  if (!runner) {
    sendJson(res, 200, { available: false, reason: "no_active_runner" });
    return;
  }
  try {
    const info = runner.agent.getSystemPromptInfo();
    sendJson(res, 200, { available: true, ...info });
  } catch (e) {
    sendJson(res, 500, { available: false, error: String(e) });
  }
}
