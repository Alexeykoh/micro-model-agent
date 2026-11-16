/** REST панели Tools: список тулов сессии и ручные on/off-тумблеры. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, MAX_BODY_BYTES } from "../../../runtime/http-body";
import {
  broadcast,
  type ConfigStore,
  type RuntimeState,
  type SessionStore,
  type SseTransport,
  type ToolStore,
  type WorkspaceStore,
} from "../state";
import { sendJson } from "../util";
import { listTools, setToolOverride } from "../session/tools-view";

type ToolsState = SessionStore &
  ConfigStore &
  WorkspaceStore &
  RuntimeState &
  SseTransport &
  ToolStore;

/** Активная сессия запроса: явный `?session=`, иначе серверно-активная. */
function sessionOf(
  s: ToolsState,
  requested?: string | null,
): string | null {
  const id = requested?.trim() || s.sessionManager?.getActive?.() || s.activeSessionId || null;
  return id || null;
}

/** `GET /api/tools?session=<id>` — все тулы + enabled/override. */
export function handleToolsGet(
  req: IncomingMessage,
  res: ServerResponse,
  s: ToolsState,
): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const sessionId = sessionOf(s, url.searchParams.get("session"));
  if (!sessionId) {
    sendJson(res, 400, { ok: false, error: "no_session" });
    return;
  }
  sendJson(res, 200, { ok: true, sessionId, tools: listTools(s, sessionId) });
}

/** `POST /api/tools {sessionId, name, enabled}` — включить/выключить один тул. */
export async function handleToolsPost(
  req: IncomingMessage,
  res: ServerResponse,
  s: ToolsState,
): Promise<void> {
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  const sessionId = sessionOf(s, typeof body?.sessionId === "string" ? body.sessionId : null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const enabled = typeof body?.enabled === "boolean" ? body.enabled : undefined;
  if (!sessionId || !name || enabled === undefined) {
    sendJson(res, 400, { ok: false, error: "invalid_request" });
    return;
  }
  const exists = listTools(s, sessionId).some((t) => t.name === name);
  if (!exists) {
    sendJson(res, 404, { ok: false, error: "unknown_tool" });
    return;
  }
  setToolOverride(s, sessionId, name, enabled);
  const tools = listTools(s, sessionId);
  broadcast({ type: "tools", ts: Date.now(), sessionId }, s);
  sendJson(res, 200, { ok: true, sessionId, tools });
}
