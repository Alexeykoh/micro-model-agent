/**
 * `GET /api/file?path=<p>` — read-only file viewer backing the chat's file
 * cards ("Open" opens the file in a new browser tab).
 *
 * Security (the server handles auth + same-origin upstream):
 *  - the path is resolved against the agent workspace and MUST stay inside it
 *    (absolute paths outside the workspace are rejected);
 *  - symlinks (and Windows junctions) are resolved first, so a link inside the
 *    workspace cannot reach a file outside it;
 *  - protected paths (`.git/`, `.env*`, keys, credentials — see
 *    `matchProtectedPath`) are rejected;
 *  - only regular text files up to {@link MAX_FILE_VIEW_BYTES} are served, so a
 *    stray binary or a multi-GB log cannot be streamed to the browser.
 */
import { readFile, realpath } from "node:fs/promises";
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
  // Cheap lexical guard first: a path that is obviously outside the workspace
  // (e.g. `../../etc/passwd`) is refused before touching the filesystem, even
  // when the target does not exist.
  const lexical = relative(resolve(base), abs);
  if (lexical.startsWith("..") || isAbsolute(lexical)) {
    sendJson(res, 403, { error: "outside_workspace" });
    return true;
  }
  void serveFile(res, base, abs);
  return true;
}

/** Resolve real paths, enforce the workspace guard, then stream the text file. */
async function serveFile(res: ServerResponse, base: string, abs: string): Promise<void> {
  let baseReal: string;
  let absReal: string;
  try {
    // `realpath` follows symlinks/junctions; without it a link inside the
    // workspace could point at any file on disk and bypass the guard below.
    baseReal = await realpath(resolve(base));
    absReal = await realpath(abs);
  } catch {
    sendJson(res, 404, { error: "not_found" });
    return;
  }

  const rel = relative(baseReal, absReal);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    sendJson(res, 403, { error: "outside_workspace" });
    return;
  }
  if (matchProtectedPath(baseReal, absReal)) {
    sendJson(res, 403, { error: "protected_path" });
    return;
  }

  try {
    const buf = await readFile(absReal);
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
  } catch {
    // A directory or an unreadable file — "not found" from the viewer's angle.
    sendJson(res, 404, { error: "not_found" });
  }
}
