/**
 * `GET/POST /v1/host/update` — панель обновления (split W4b-4).
 *
 * GET отдаёт текущую версию и доступный апдейт; POST запускает установку
 * тем же `UpdaterModule.installNow()`, что и `POST /api/update` в web-режиме.
 * Уведомления апдейтера (`available`/`installing`/`installed`/`failed`)
 * публикуются в SSE-потоки активных сессий как событие `update`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { UpdateNotice } from "../../../modules/updater/module";
import { emitSessionEvent } from "../runtime/emit";
import { sendJson } from "../http/respond";
import type { AgentServiceState } from "../state";

/** `/v1/host/update`; `true` — запрос обработан. */
export async function handleHostUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
  parts: string[],
): Promise<boolean> {
  if (parts.length !== 3 || parts[2] !== "update") return false;
  const updater = s.deps.updater;
  if (!updater) {
    sendJson(res, 503, { ok: false, error: "updater_unavailable" });
    return true;
  }
  if (req.method === "GET") {
    sendJson(res, 200, {
      current: updater.getUpdater().getCurrentVersion(),
      updateAvailable: s.updateAvailable !== undefined,
      ...(s.updateAvailable ? { latest: s.updateAvailable.latest } : {}),
    });
    return true;
  }
  if (req.method !== "POST") return false;
  try {
    const result = await updater.installNow();
    sendJson(res, 200, {
      ok: result.success,
      ...(result.installed ? { installed: result.installed } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return true;
}

/** Запоминает доступный апдейт и рассылает его активным SSE-сессиям. */
export function publishUpdateNotice(s: AgentServiceState, notice: UpdateNotice): void {
  s.updateAvailable =
    notice.phase === "available" && notice.latest
      ? { current: notice.current, latest: notice.latest }
      : undefined;
  const sessions = new Set([...s.clients].map((client) => client.sessionId));
  for (const sessionId of sessions) emitSessionEvent(s, sessionId, "update", notice);
}
