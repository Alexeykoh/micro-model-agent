/**
 * `GET /v1/host/files?path=` — листинг директории workspace для панели Files
 * (split W4b). Тот же джейл и те же игноры, что у web: один runtime-слой.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { stat } from "node:fs/promises";
import {
  apiHiddenGlobs,
  hiddenReason,
  listDir,
  resolveWorkspacePath,
} from "../../../runtime/workspace-fs";
import { sendJson, sendProblem } from "../http/respond";
import { problem } from "../runtime/problem";
import type { AgentServiceState } from "../state";

const STATUS: Record<string, number> = {
  outside_workspace: 403,
  protected_path: 403,
  not_found: 404,
};

/** `/v1/host/files`; `true` — запрос обработан. */
export function handleHostFiles(
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  s: AgentServiceState,
  parts: string[],
): boolean {
  if (parts.length !== 3 || parts[2] !== "files" || req.method !== "GET") return false;
  const base = s.deps.baseDir;
  if (!base) {
    sendProblem(res, problem({ type: "internal", title: "workspace unavailable", status: 503 }));
    return true;
  }
  void serveList(res, base, s, reqUrl.searchParams.get("path") ?? "");
  return true;
}

async function serveList(
  res: ServerResponse,
  base: string,
  s: AgentServiceState,
  raw: string,
): Promise<void> {
  const resolved = await resolveWorkspacePath(base, raw || ".");
  if (!resolved.ok) {
    sendJson(res, STATUS[resolved.code] ?? 404, { error: resolved.code });
    return;
  }
  const hidden = apiHiddenGlobs(s.config);
  if (hiddenReason(resolved.absReal, resolved.baseReal, hidden)) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  try {
    if (!(await stat(resolved.absReal)).isDirectory()) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    const { entries, truncated } = await listDir(resolved.baseReal, resolved.absReal, hidden);
    sendJson(res, 200, { path: raw, entries, truncated });
  } catch {
    sendJson(res, 404, { error: "not_found" });
  }
}
