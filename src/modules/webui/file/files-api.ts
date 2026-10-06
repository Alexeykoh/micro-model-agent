// `GET /api/files?path=<relative-dir>` — read-only листинг ОДНОЙ директории
// workspace для вкладки Files (ленивое дерево: клиент запрашивает папку при
// раскрытии). В отличие от `/api/file` (открывается вкладкой браузера и отдаёт
// `text/plain`), здесь ответ читает JS — поэтому JSON и JSON-коды ошибок.
//
// Джейл/защита путей — общий резолвер (`./paths`). Шум фильтруется теми же
// примитивами индексатора (IGNORE_DIRS, `.gitignore`/`.mmaignore`), чтобы дерево
// и карта проекта не расходились.
import { readdir, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIgnoredDirName, isIgnoredFileName } from "../../indexer/walker";
import { loadIgnoreMatcher } from "../../indexer/gitignore";
import { matchProtectedPath } from "../../security/protected-paths";
import { sendJson } from "../util";
import type { WorkspaceStore } from "../state";
import { resolveWorkspacePath } from "./paths";

/** Кап записей одной директории; при упоре дерево помечается `truncated`. */
export const MAX_DIR_ENTRIES = 1000;

/** Запись дерева: имя, тип и размер (у файлов). */
export interface FileEntry {
  name: string;
  type: "dir" | "file";
  size?: number;
}

/** Листинг директории для веб-вкладки Files. */
export interface DirListing {
  entries: FileEntry[];
  truncated: boolean;
}

/**
 * Листит одну директорию `dirAbs`, возвращая видимые записи (папки сверху,
 * затем файлы; регистронезависимо по алфавиту). Бросает при ошибке чтения.
 */
export async function listDir(base: string, dirAbs: string): Promise<DirListing> {
  const matcher = loadIgnoreMatcher(base, (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  });
  const relDir = toPosix(relative(base, dirAbs)).replace(/^\.$/, "").replace(/^\/+/, "");
  const dirents = await readdir(dirAbs, { withFileTypes: true });
  const visible = dirents.filter((d) => isVisibleEntry(d, dirAbs, relDir, base, matcher));
  const capped = visible.slice(0, MAX_DIR_ENTRIES);
  const entries = await Promise.all(
    capped.map((d) => toEntry(dirAbs, d.name, d.isDirectory())),
  );
  sortEntries(entries);
  return { entries, truncated: visible.length > MAX_DIR_ENTRIES };
}

/** True, если запись не скрыта игнорами индексатора или protected-паттерном. */
function isVisibleEntry(
  d: { name: string; isDirectory(): boolean; isFile(): boolean },
  dirAbs: string,
  relDir: string,
  base: string,
  matcher: ReturnType<typeof loadIgnoreMatcher>,
): boolean {
  const isDir = d.isDirectory();
  if (!isDir && !d.isFile()) return false;
  const relChild = relDir ? `${relDir}/${d.name}` : d.name;
  if (isDir ? isIgnoredDirName(d.name) : isIgnoredFileName(d.name)) return false;
  if (matcher.ignores(relChild, isDir)) return false;
  return !matchProtectedPath(base, join(dirAbs, d.name));
}

/** Строит запись дерева (с размером у файлов; недоступный размер опускается). */
async function toEntry(dirAbs: string, name: string, isDir: boolean): Promise<FileEntry> {
  if (isDir) return { name, type: "dir" };
  try {
    const size = (await stat(join(dirAbs, name))).size;
    return { name, type: "file", size };
  } catch {
    return { name, type: "file" };
  }
}

/** Папки сверху, затем файлы; регистронезависимо по алфавиту. */
function sortEntries(entries: FileEntry[]): void {
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/** Нормализует сепараторы Windows в прямой слэш. */
function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

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
  s: WorkspaceStore,
): boolean {
  if (reqUrl.pathname !== "/api/files" || req.method !== "GET") return false;

  const base = s.workspace;
  if (!base) {
    sendJson(res, 503, { error: "workspace_unavailable" });
    return true;
  }
  const raw = reqUrl.searchParams.get("path") ?? "";
  void serveList(res, base, raw);
  return true;
}

/** Резолвит директорию внутри workspace и отдаёт её листинг как JSON. */
async function serveList(res: ServerResponse, base: string, raw: string): Promise<void> {
  const resolved = await resolveWorkspacePath(base, raw || ".");
  if (!resolved.ok) {
    sendJson(res, STATUS[resolved.code] ?? 404, { error: resolved.code });
    return;
  }
  try {
    if (!(await stat(resolved.absReal)).isDirectory()) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    const { entries, truncated } = await listDir(base, resolved.absReal);
    sendJson(res, 200, { path: raw || "", entries, truncated });
  } catch {
    sendJson(res, 404, { error: "not_found" });
  }
}
