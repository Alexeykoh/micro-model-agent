// «Изменённые файлы» проекта для панели LSP: только рабочее дерево, без обхода
// всего проекта. Источник — `git status --porcelain -z` (быстро и точно);
// нет git/репозитория — честный отказ, а не молчаливый пустой список.
import { execFile } from "child_process";
import { promisify } from "util";
import { resolve } from "path";
import { existsSync } from "fs";

const execFileAsync = promisify(execFile);

/** Сколько файлов проверяем за один запрос (best practice: bounded work). */
export const CHANGED_FILES_LIMIT = 20;

/**
 * Разобрать `git status --porcelain=v1 -z`. Возвращает пути относительно
 * корня, пропускает удалённые и `.mma/`. Экспортируется для тестов без git.
 */
export function parsePorcelain(out: string, limit = CHANGED_FILES_LIMIT): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const chunk of out.split("\0")) {
    if (chunk.length < 4) continue;
    const status = chunk.slice(0, 2);
    const path = chunk.slice(3).trim();
    if (!path || path.startsWith(".mma/") || path === ".mma") continue;
    // Удалённые файлы проверять нечем (и они не «изменены» для LSP).
    if (status.includes("D")) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
    if (paths.length >= limit) break;
  }
  return paths;
}

/** Изменённые файлы рабочего дерева (git). Бросает, если git недоступен. */
export async function listChangedFiles(
  baseDir: string,
  limit = CHANGED_FILES_LIMIT,
): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", baseDir, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
  );
  return parsePorcelain(String(stdout), limit).filter((p) => existsSync(resolve(baseDir, p)));
}
