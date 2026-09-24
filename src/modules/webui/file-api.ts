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
 *
 * Responses — success and error alike — are `text/plain`, because this endpoint
 * is opened directly as a browser tab (a JSON body would render raw). Text is
 * decoded with a UTF-16 LE/BE BOM or a UTF-8 BOM; NUL bytes elsewhere mean a
 * binary file and are refused. One limitation: auth and same-origin rejections
 * happen upstream in `server.ts` and stay JSON — they are only reachable when
 * the auth cookie is missing/forged, not from a real viewer tab.
 */
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { matchProtectedPath } from "../security/protected-paths";
import { t } from "../../i18n/index";
import type { WebUiState } from "./state";

/** Cap for a viewed file; larger files are refused rather than truncated. */
export const MAX_FILE_VIEW_BYTES = 512 * 1024;

/** The viewer is opened as a browser tab — errors must read as text, not JSON. */
function sendTextError(
  res: ServerResponse,
  status: number,
  key: string,
  vars?: Record<string, string>,
): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(t(key, vars));
}

/** Decode a text buffer, honouring a UTF-16/UTF-8 BOM; NUL elsewhere means binary. */
export function decodeText(buf: Buffer): { text: string; binary: boolean } {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString("utf16le"), binary: false };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // `swap16` rejects an odd byte count, so swap only the even prefix.
    const body = buf.subarray(2);
    const even = body.length - (body.length % 2);
    const swapped = Buffer.from(body.subarray(0, even));
    swapped.swap16();
    return { text: swapped.toString("utf16le"), binary: false };
  }
  const body =
    buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
      ? buf.subarray(3)
      : buf;
  if (body.includes(0)) return { text: "", binary: true };
  return { text: body.toString("utf8"), binary: false };
}

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
    sendTextError(res, 503, "web.file.error.workspace_unavailable");
    return true;
  }
  const raw = reqUrl.searchParams.get("path") ?? "";
  if (!raw) {
    sendTextError(res, 400, "web.file.error.missing_path");
    return true;
  }

  const abs = isAbsolute(raw) ? resolve(raw) : resolve(base, raw);
  // Cheap lexical guard first: a path that is obviously outside the workspace
  // (e.g. `../../etc/passwd`) is refused before touching the filesystem, even
  // when the target does not exist.
  const lexical = relative(resolve(base), abs);
  if (lexical.startsWith("..") || isAbsolute(lexical)) {
    sendTextError(res, 403, "web.file.error.outside_workspace");
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
    sendTextError(res, 404, "web.file.error.not_found");
    return;
  }

  const rel = relative(baseReal, absReal);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    sendTextError(res, 403, "web.file.error.outside_workspace");
    return;
  }
  if (matchProtectedPath(baseReal, absReal)) {
    sendTextError(res, 403, "web.file.error.protected_path");
    return;
  }

  try {
    const buf = await readFile(absReal);
    if (buf.length > MAX_FILE_VIEW_BYTES) {
      sendTextError(res, 413, "web.file.error.too_large", {
        limit: String(MAX_FILE_VIEW_BYTES),
      });
      return;
    }
    const { text, binary } = decodeText(buf);
    if (binary) {
      sendTextError(res, 415, "web.file.error.binary_file");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(text);
  } catch {
    // A directory or an unreadable file — "not found" from the viewer's angle.
    sendTextError(res, 404, "web.file.error.not_found");
  }
}
