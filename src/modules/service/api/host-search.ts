/**
 * `GET /v1/host/search?q=&names=1` (split W10) — ограниченный поиск по
 * workspace для панели Files и `@`-mentions в daemon-режиме.
 *
 * Обход начинается только от workspace демона и подчиняется тем же игнорам и
 * policies, что локальный `/api/search` (общий `runtime/file-search`).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { MAX_SEARCH_QUERY, searchWorkspace } from "../../../runtime/file-search";
import { apiHiddenGlobs, resolveWorkspacePath } from "../../../runtime/workspace-fs";
import { sendJson } from "../http/respond";
import type { AgentServiceState } from "../state";

/** Обрабатывает поиск; `false` — путь не наш. */
export async function handleHostSearch(
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  s: AgentServiceState,
  parts: string[],
): Promise<boolean> {
  if (parts.length !== 3 || parts[2] !== "search") return false;
  if (req.method !== "GET") return false;

  const base = s.deps.baseDir;
  if (!base) {
    sendJson(res, 503, { error: "workspace_unavailable" });
    return true;
  }
  const q = (reqUrl.searchParams.get("q") ?? "").trim();
  if (!q) {
    sendJson(res, 400, { error: "missing_query" });
    return true;
  }
  if (q.length > MAX_SEARCH_QUERY) {
    sendJson(res, 400, { error: "query_too_long", limit: MAX_SEARCH_QUERY });
    return true;
  }
  const resolved = await resolveWorkspacePath(base, ".");
  if (!resolved.ok) {
    sendJson(res, resolved.code === "not_found" ? 404 : 403, { error: resolved.code });
    return true;
  }
  try {
    const result = await searchWorkspace(
      resolved.baseReal,
      q,
      apiHiddenGlobs(s.config),
      { namesOnly: reqUrl.searchParams.get("names") === "1" },
    );
    sendJson(res, 200, result);
  } catch {
    sendJson(res, 500, { error: "search_failed" });
  }
  return true;
}
