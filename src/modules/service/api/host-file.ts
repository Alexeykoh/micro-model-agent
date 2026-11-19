/**
 * `GET /v1/host/file?path=&download=1` (split W10) — вьюер файла в
 * daemon-режиме. Логика общая с `/api/file` (`runtime/file-view`): тот же джейл,
 * политика скрытых путей и кап размера.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { serveFileRequest } from "../../../runtime/file-view";
import type { AgentServiceState } from "../state";

/** Обрабатывает вьюер; `false` — путь не наш. */
export function handleHostFile(
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  s: AgentServiceState,
  parts: string[],
): boolean {
  if (parts.length !== 3 || parts[2] !== "file" || req.method !== "GET") return false;
  serveFileRequest(res, reqUrl, { workspace: s.deps.baseDir ?? process.cwd(), config: s.config });
  return true;
}
