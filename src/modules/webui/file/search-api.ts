// `GET /api/search?q=<подстрока>` — ограниченный поиск по содержимому
// workspace для вкладки Files (C-01).
//
// Путь не принимается: обход начинается только от `s.workspace`, поэтому
// запрос не может выйти за его пределы (INV-S1). Игноры/защита —
// `searchWorkspace` (`./search.ts`). Ответ — JSON: ошибки читает JS.
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../util";
import { apiHiddenGlobs, type PathPolicyStore } from "./hidden";
import { resolveWorkspacePath } from "./paths";
import { MAX_SEARCH_QUERY, searchWorkspace } from "./search";

/** Обрабатывает `/api/search`; `false` — роут чужой. */
export function handleSearchApi(
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  s: PathPolicyStore,
): boolean {
  if (reqUrl.pathname !== "/api/search" || req.method !== "GET") return false;

  const base = s.workspace;
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
  void serveSearch(res, base, q, apiHiddenGlobs(s.config));
  return true;
}

/** Резолвит реальный корень workspace и отдаёт результат поиска как JSON. */
async function serveSearch(
  res: ServerResponse,
  base: string,
  query: string,
  hiddenGlobs: readonly string[],
): Promise<void> {
  const resolved = await resolveWorkspacePath(base, ".");
  if (!resolved.ok) {
    sendJson(res, resolved.code === "not_found" ? 404 : 403, { error: resolved.code });
    return;
  }
  try {
    const result = await searchWorkspace(resolved.baseReal, query, hiddenGlobs);
    sendJson(res, 200, result);
  } catch {
    // Обход не должен выглядеть пустым успехом: ошибка видна клиенту.
    sendJson(res, 500, { error: "search_failed" });
  }
}
