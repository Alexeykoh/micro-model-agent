// DEBT(git-actions-ui-v2): stage/commit из веб-вкладки — следующая итерация
// (read-only v1, спека git-workflow §6.1/§11).
// Git-роуты веба (спека git-workflow §6.1): **только чтение**, только GET.
//
// `GET /api/git` — снимок (ветка/dirty/worktree/теги) из TTL-кеша;
// `GET /api/git/changes` — список изменённых файлов (porcelain -z);
// `GET /api/git/diff?path=<f>&staged=0|1` — diff одного файла с капом ответа.
//
// Пишущих git-роутов в v1 нет (решение пользователя §1): stage/commit — долг
// `git-actions-ui-v2`. Вне репозитория — `repo:false` и 200: чипы молча
// скрываются, это не ошибка.
import type { IncomingMessage, ServerResponse } from "node:http";
import { relative } from "node:path";
import { runGit, capDiff, gitSnapshot, type GitSnapshot } from "../../../tools/git-core";
import { hiddenReason } from "../../security/data-policy/path-policy";
import { sendJson } from "../util";
import { resolveWorkspacePath } from "../file/paths";
import { apiHiddenGlobs, type PathPolicyStore } from "../file/hidden";
import { createGitCache, gitSnapshotCached, type GitCacheState } from "./snapshot-cache";

/** Кап списка изменений: сверх — `truncated` (диффы всё равно по одному файлу). */
export const GIT_CHANGES_MAX_FILES = 2000;

/** Узкий вход git-роутов (расширяет файловый: workspace + конфиг). */
export interface GitApiStore extends PathPolicyStore {
  /** Серверный кеш снимка (`module.ts` создаёт один на состояние). */
  gitCache?: GitCacheState;
  /** Счётчик вотчера — рост инвалидирует снимок. */
  filesRevision?: number;
}

/** Статусы ответа по коду резолва пути (как в `/api/files`). */
const PATH_STATUS: Record<string, number> = {
  outside_workspace: 403,
  protected_path: 403,
  not_found: 404,
};

/** Обрабатывает `/api/git*`; `false` — роут чужой (проваливаемся дальше). */
export function handleGitApi(
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  s: GitApiStore,
): boolean {
  const p = reqUrl.pathname;
  if (!p.startsWith("/api/git")) return false;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }
  const base = s.workspace;
  if (!base) {
    sendJson(res, 503, { error: "workspace_unavailable" });
    return true;
  }
  const cache = s.gitCache ?? createGitCache();
  const rev = s.filesRevision ?? 0;
  if (p === "/api/git") {
    void serveSnapshot(res, base, cache, rev);
    return true;
  }
  if (p === "/api/git/changes") {
    void serveChanges(res, base, cache, rev);
    return true;
  }
  if (p === "/api/git/diff") {
    void serveDiff(res, reqUrl, base, s);
    return true;
  }
  sendJson(res, 404, { error: "not_found" });
  return true;
}

async function serveSnapshot(
  res: ServerResponse,
  base: string,
  cache: GitCacheState,
  rev: number,
): Promise<void> {
  const snap = await gitSnapshotCached(cache, base, rev);
  sendJson(res, 200, snap ?? { repo: false });
}

/**
 * Список изменений из кеша-снимка (тот же `git status`, что и чипы — второй
 * вызов на один тик не плодим).
 */
async function serveChanges(
  res: ServerResponse,
  base: string,
  cache: GitCacheState,
  rev: number,
): Promise<void> {
  const snap = await gitSnapshotCached(cache, base, rev);
  if (!snap?.repo) {
    sendJson(res, 200, { repo: false, files: [] });
    return;
  }
  const files = snap.files ?? [];
  sendJson(res, 200, {
    repo: true,
    branch: snap.branch,
    files: files.slice(0, GIT_CHANGES_MAX_FILES),
    truncated: files.length > GIT_CHANGES_MAX_FILES,
  });
}

/**
 * Diff одного файла. Путь резолвится тем же workspace-джайлом, что и `/api/file`
 * (симлинк наружу и protected-пути — отказ). Пустой diff у untracked-файла —
 * честный `untracked:true`, а не молчание.
 */
async function serveDiff(
  res: ServerResponse,
  reqUrl: URL,
  base: string,
  s: GitApiStore,
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
  const rel = toPosix(relative(resolved.baseReal, resolved.absReal));
  const argv = ["diff", "--no-color", ...(staged ? ["--cached"] : []), "--", rel];
  const d = await runGit(resolved.baseReal, argv);
  if (!d.ok) {
    const code = d.blocked ?? (d.timedOut ? "git_timeout" : "git_error");
    sendJson(res, 500, { error: String(code).slice(0, 200) });
    return;
  }
  if (!d.stdout.trim()) {
    // Пустой diff: untracked-файл либо «нет изменений» — различаем честно.
    const st = await runGit(resolved.baseReal, ["status", "--porcelain=v1", "-z", "--", rel]);
    const untracked = st.ok && st.stdout.slice(0, 2) === "??";
    sendJson(res, 200, { diff: "", truncated: false, bytes: 0, untracked });
    return;
  }
  const capped = capDiff(d.stdout);
  sendJson(res, 200, {
    diff: capped.diff,
    truncated: capped.truncated,
    bytes: Buffer.byteLength(capped.diff, "utf8"),
  });
}

/** Нормализует сепараторы Windows в прямой слэш. */
function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Прогрев без кеша в состоянии (тесты/стабы): собрать снимок напрямую. */
export async function freshGitSnapshot(base: string): Promise<GitSnapshot> {
  return gitSnapshot(base);
}
