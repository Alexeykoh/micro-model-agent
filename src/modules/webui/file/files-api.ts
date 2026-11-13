// `GET /api/files?path=<relative-dir>` — read-only листинг ОДНОЙ директории
// workspace для вкладки Files (ленивое дерево: клиент запрашивает папку при
// раскрытии). В отличие от `/api/file` (открывается вкладкой браузера и отдаёт
// `text/plain`), здесь ответ читает JS — поэтому JSON и JSON-коды ошибок.
//
// Джейл/защита путей — общий резолвер (`./paths`). Шум фильтруется теми же
// примитивами индексатора (IGNORE_DIRS, `.gitignore`/`.mmaignore`), чтобы дерево
// и карта проекта не расходились.
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { hiddenReason, listDir, type PathPolicyStore, resolveWorkspacePath } from "../../../runtime/workspace-fs";
import { sendJson } from "../util";
import { apiHiddenGlobs } from "./hidden";

export { MAX_DIR_ENTRIES, type DirListing, type FileEntry, listDir } from "../../../runtime/workspace-fs";

const STATUS: Record<string, number> = {
  outside_workspace: 403,
  protected_path: 403,
  not_found: 404,
};

/** Обрабатывает `/api/files`; `false` — роут чужой (проваливаемся дальше). */
export function handleFilesApi(
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  s: PathPolicyStore,
): boolean {
  if (reqUrl.pathname !== "/api/files" || req.method !== "GET") return false;

  const base = s.workspace;
  if (!base) {
    sendJson(res, 503, { error: "workspace_unavailable" });
    return true;
  }
  const raw = reqUrl.searchParams.get("path") ?? "";
  void serveList(res, base, raw, apiHiddenGlobs(s.config));
  return true;
}

/** Резолвит директорию внутри workspace и отдаёт её листинг как JSON. */
async function serveList(
  res: ServerResponse,
  base: string,
  raw: string,
  hiddenGlobs: readonly string[],
): Promise<void> {
  const resolved = await resolveWorkspacePath(base, raw || ".");
  if (!resolved.ok) {
    sendJson(res, STATUS[resolved.code] ?? 404, { error: resolved.code });
    return;
  }
  // Скрытая директория неотличима от несуществующей (INV-D6).
  if (hiddenReason(resolved.absReal, resolved.baseReal, hiddenGlobs)) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  try {
    if (!(await stat(resolved.absReal)).isDirectory()) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    const { entries, truncated } = await listDir(resolved.baseReal, resolved.absReal, hiddenGlobs);
    sendJson(res, 200, { path: raw || "", entries, truncated });
  } catch {
    sendJson(res, 404, { error: "not_found" });
  }
}
