import { existsSync } from "fs";
import { dirname, join, relative, isAbsolute } from "path";
import { platform } from "os";

/**
 * Resolve the LSP workspace root for an edited file.
 *
 * The workspace root must be the nearest project of the *edited file*, not the
 * agent baseDir — tsserver resolves `typescript` relative to the workspace
 * root, so for a file in `bicycle-shop/src/x.ts` under baseDir `mma_tests` the
 * root must be `bicycle-shop` (observed: "Could not find a valid TypeScript
 * installation" on every write/edit because baseDir had no node_modules).
 *
 * Which files mark a project root is language-specific and is declared in the
 * LSP server config (`LspServerConfig.workspaceMarkers`) — this function takes
 * the markers as a parameter and performs no language detection itself.
 */
/**
 * Находит локальный компилятор TypeScript, поднимаясь от `startDir` вверх по
 * `node_modules`. Возвращает готовую команду или null, если tsc не установлен.
 *
 * Почему не `npx`: обёртка npx тратит 5–13 секунд даже на локальный пакет
 * (Windows), а без локального typescript пытается лезть в сеть. Прямой вызов
 * локального tsc — доли секунды и честная деградация (null → пропускаем).
 *
 * Кросс-платформенность:
 * - предпочитаем JS-энтрипоинт `typescript/bin/tsc` и запускаем его ТЕКУЩИМ
 *   рантаймом (`process.execPath` — bun или node). Так не зависим от `node` в
 *   PATH (актуально для систем только с Bun) и одинаково работает на
 *   Windows/macOS/Linux;
 * - если JS-файла нет, но есть `.bin`-стаб, берём его: на Windows `tsc.cmd`,
 *   на macOS/Linux `tsc` (обёртка сама найдёт интерпретатор).
 */
export function resolveTscCommand(startDir: string, maxLevels = 8): string | null {
  const runtime = process.execPath;
  let dir = startDir;
  for (let i = 0; i < maxLevels; i++) {
    const js = join(dir, "node_modules", "typescript", "bin", "tsc");
    if (existsSync(js)) return `"${runtime}" "${js}"`;
    const stub = join(dir, "node_modules", ".bin", platform() === "win32" ? "tsc.cmd" : "tsc");
    if (existsSync(stub)) return `"${stub}"`;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function findProjectRoot(filePath: string, baseDir: string, markers: string[]): string {
  if (!markers || markers.length === 0) return baseDir;
  let dir = dirname(filePath);
  const root = baseDir.replace(/[\\/]+$/, "");
  // Clamp the walk to baseDir: callers that pass baseDir itself as filePath
  // (probes) start at dirname(baseDir) — ABOVE the sandbox — and would pick up
  // a marker directory from the parent (e.g. a package.json next to it).
  const rel = relative(root, dir);
  if ((rel && rel.startsWith("..")) || isAbsolute(rel)) dir = root;
  while (true) {
    if (markers.some((m) => existsSync(join(dir, m)))) {
      return dir;
    }
    if (dir === root) return dir;
    const parent = dirname(dir);
    if (parent === dir) return root;
    dir = parent;
  }
}
