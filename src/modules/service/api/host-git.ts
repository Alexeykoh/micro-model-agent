/**
 * `/v1/host/git*` — read-only git для панели Changes (split W4b-2).
 *
 * Только чтение, как и веб-v1: `GET .../git` (снимок), `.../git/changes`
 * (porcelain), `.../git/diff?path=&staged=`. Пишущих git-действий нет
 * (DEBT(git-actions-ui-v2)).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { relative } from "node:path";
import { capDiff, gitSnapshot, runGit } from "../../../tools/git-core";
import { apiHiddenGlobs, hiddenReason, resolveWorkspacePath } from "../../../runtime/workspace-fs";
import { sendJson, sendProblem } from "../http/respond";
import { problem } from "../runtime/problem";
import type { AgentServiceState } from "../state";

/** Кап списка изменений. */
const CHANGES_MAX_FILES = 2000;

const PATH_STATUS: Record<string, number> = {
  outside_workspace: 403,
  protected_path: 403,
  not_found: 404,
};

/** `/v1/host/git[...]`; `true` — запрос обработан. */
export function handleHostGit(
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  s: AgentServiceState,
  parts: string[],
): boolean {
  if (parts[2] !== "git" || req.method !== "GET") return false;
  const base = s.deps.baseDir;
  if (!base) {
    sendProblem(res, problem({ type: "internal", title: "workspace unavailable", status: 503 }));
    return true;
  }
  const action = parts[3] ?? "";
  if (parts.length === 3) {
    void serveSnapshot(res, base);
    return true;
  }
  if (action === "changes") {
    void serveChanges(res, base);
    return true;
  }
  if (action === "diff") {
    void serveDiff(res, base, s, reqUrl);
    return true;
  }
  return false;
}

async function serveSnapshot(res: ServerResponse, base: string): Promise<void> {
  sendJson(res, 200, (await gitSnapshot(base)) ?? { repo: false });
}

async function serveChanges(res: ServerResponse, base: string): Promise<void> {
  const snap = await gitSnapshot(base);
  if (!snap?.repo) {
    sendJson(res, 200, { repo: false, files: [] });
    return;
  }
  const files = snap.files ?? [];
  sendJson(res, 200, {
    repo: true,
    branch: snap.branch,
    files: files.slice(0, CHANGES_MAX_FILES),
    truncated: files.length > CHANGES_MAX_FILES,
  });
}

async function serveDiff(
  res: ServerResponse,
  base: string,
  s: AgentServiceState,
  reqUrl: URL,
): Promise<void> {
  const raw = reqUrl.searchParams.get("path") ?? "";
  if (!raw) {
    sendJson(res, 400, { error: "path_required" });
    return;
  }
  const staged = reqUrl.searchParams.get("staged") === "1";
  const resolved = await resolveWorkspacePath(base, raw);
  if (!resolved.ok) {
    sendJson(res, PATH_STATUS[resolved.code] ?? 404, { error: resolved.code });
    return;
  }
  if (hiddenReason(resolved.absReal, resolved.baseReal, apiHiddenGlobs(s.config))) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  const rel = relative(resolved.baseReal, resolved.absReal).replace(/\\/g, "/");
  const diff = await runGit(resolved.baseReal, [
    "diff",
    "--no-color",
    ...(staged ? ["--cached"] : []),
    "--",
    rel,
  ]);
  if (!diff.ok) {
    const code = diff.blocked ?? (diff.timedOut ? "git_timeout" : "git_error");
    sendJson(res, 500, { error: String(code).slice(0, 200) });
    return;
  }
  if (!diff.stdout.trim()) {
    const status = await runGit(resolved.baseReal, ["status", "--porcelain=v1", "-z", "--", rel]);
    const untracked = status.ok && status.stdout.slice(0, 2) === "??";
    sendJson(res, 200, { diff: "", truncated: false, bytes: 0, untracked });
    return;
  }
  const capped = capDiff(diff.stdout);
  sendJson(res, 200, {
    diff: capped.diff,
    truncated: capped.truncated,
    bytes: Buffer.byteLength(capped.diff, "utf8"),
  });
}
