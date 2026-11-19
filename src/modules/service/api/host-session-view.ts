/**
 * Host-wire read-поверхность сессии (split W10): системный промпт, журнал
 * защиты и прогоны субагентов.
 *
 * Локальный веб отдаёт те же данные из своих API; демон обязан отдать их
 * тонкому клиенту, иначе панели в daemon-режиме пустеют.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { MAX_SECURITY_LIMIT, mergeSecurityEvents, clampSecurityLimit } from "../../../runtime/security-view";
import { sendJson } from "../http/respond";
import type { AgentServiceState } from "../state";

/** Обрабатывает `/v1/host/sessions/:id/{system-prompt|security|subagents}`. */
export function handleHostSessionView(
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  s: AgentServiceState,
  parts: string[],
): boolean {
  const id = decodeURIComponent(parts[3]);
  const action = parts[4];
  if (action === "system-prompt") return systemPrompt(res, s, id);
  if (action === "security") return security(res, s, id, reqUrl);
  if (action === "subagents") {
    if (parts.length === 5 && req.method === "GET") return subagentRuns(res, s, id, reqUrl);
    if (parts.length === 7 && parts[6] === "interrupt" && req.method === "POST") {
      return interruptSubagent(res, s, id, decodeURIComponent(parts[5]));
    }
  }
  return false;
}

/** `GET …/system-prompt` — текст и состав; без раннера `available:false`. */
function systemPrompt(res: ServerResponse, s: AgentServiceState, id: string): boolean {
  const runner = s.pool.getRunner(id);
  if (!runner) {
    sendJson(res, 200, { available: false, reason: "no_active_runner" });
    return true;
  }
  try {
    sendJson(res, 200, { available: true, ...runner.agent.getSystemPromptInfo() });
  } catch (e) {
    sendJson(res, 500, { available: false, error: String(e) });
  }
  return true;
}

/** `GET …/security?limit=` — события защиты сессии. */
function security(
  res: ServerResponse,
  s: AgentServiceState,
  id: string,
  reqUrl: URL,
): boolean {
  const dir = s.deps.sessionManager?.getSessionDirectory?.(id);
  sendJson(res, 200, {
    events: mergeSecurityEvents(id, clampSecurityLimit(reqUrl.searchParams.get("limit")), dir),
    cap: MAX_SECURITY_LIMIT,
  });
  return true;
}

/** `GET …/subagents[?toolCallId=]` — снимки прогонов сессии. */
function subagentRuns(
  res: ServerResponse,
  s: AgentServiceState,
  id: string,
  reqUrl: URL,
): boolean {
  const toolCallId = reqUrl.searchParams.get("toolCallId") ?? undefined;
  sendJson(res, 200, { runs: s.subagentRuns.list(id, toolCallId) });
  return true;
}

/** `POST …/subagents/:runId/interrupt` — остановить прогон. */
function interruptSubagent(
  res: ServerResponse,
  s: AgentServiceState,
  id: string,
  runId: string,
): boolean {
  const status = s.subagentRuns.interrupt(id, runId);
  if (status === "not_found") {
    sendJson(res, 404, { error: "not_found" });
    return true;
  }
  if (status === "not_running") {
    sendJson(res, 409, { error: "not_running" });
    return true;
  }
  sendJson(res, 200, { ok: true });
  return true;
}
