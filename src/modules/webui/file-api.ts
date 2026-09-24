/**
 * `GET /api/file?path=<p>` — read-only file viewer backing the chat's file
 * cards ("Open" opens the file in a new browser tab).
 *
 * Security (the server handles auth + same-origin upstream):
 *  - the path is resolved against the agent workspace and MUST stay inside it
 *    (absolute paths outside the workspace are rejected);
 *  - protected paths (`.git/`, `.env*`, keys, credentials — see
 *    `matchProtectedPath`) are rejected;
 *  - only regular text files up to {@link MAX_FILE_VIEW_BYTES} are served, so a
 *    stray binary or a multi-GB log cannot be streamed to the browser.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { matchProtectedPath } from "../security/protected-paths";
import { sendJson } from "./util";
import type { WebUiState } from "./state";

/** Cap for a viewed file; larger files are refused rather than truncated. */
export const MAX_FILE_VIEW_BYTES = 512 * 1024;

/**
 * Handle `/api/file`. Returns `false` when the request is not for this route so
 * the caller can fall through to the next handler.
 */
export function handleFileApi(
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  s: WebUiState,
): boolean {
  if (reqUrl.pathname !== "/api/file" || req.method !== "GET") return false;

  const base = s.workspace;
  if (!base) {
    sendJson(res, 503, { error: "workspace_unavailable" });
    return true;
  }
  const raw = reqUrl.searchParams.get("path") ?? "";
  if (!raw) {
    sendJson(res, 400, { error: "missing_path" });
    return true;
  }

  const abs = isAbsolute(raw) ? resolve(raw) : resolve(base, raw);
  const rel = relative(resolve(base), abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    sendJson(res, 403, { error: "outside_workspace" });
    return true;
  }
  if (matchProtectedPath(base, abs)) {
    sendJson(res, 403, { error: "protected_path" });
    return true;
  }

  readFile(abs)
    .then((buf) => {
      if (buf.length > MAX_FILE_VIEW_BYTES) {
        sendJson(res, 413, { error: "file_too_large", limit: MAX_FILE_VIEW_BYTES });
        return;
      }
      if (buf.includes(0)) {
        sendJson(res, 415, { error: "binary_file" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(buf.toString("utf8"));
    })
    .catch(() => {
      // Missing path, a directory, or an unreadable file — all are "not found"
      // from the viewer's point of view.
      sendJson(res, 404, { error: "not_found" });
    });

  return true;
}
