// Корень LSP-workspace по маркерам и поиск локального tsc вверх по node_modules.
import { existsSync } from "fs";
import { dirname, join, relative, isAbsolute } from "path";
import { platform } from "os";

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

/**
 * Корень LSP-workspace для редактируемого файла.
 * Корень — ближайший проект *редактируемого файла*, не baseDir агента:
 * tsserver резолвит `typescript` от корня workspace (наблюдалось: "Could not
 * find a valid TypeScript installation" на каждый write/edit, когда у baseDir
 * не было node_modules). Какие файлы маркируют корень — языко-специфично
 * (`LspServerConfig.workspaceMarkers`); функция маркеры принимает параметром
 * и детектом языка не занимается.
 */
export function findProjectRoot(filePath: string, baseDir: string, markers: string[]): string {
  if (!markers || markers.length === 0) return baseDir;
  let dir = dirname(filePath);
  const root = baseDir.replace(/[\\/]+$/, "");
  // Обход клампим к baseDir: вызывающие с самим baseDir как filePath (пробы)
  // стартуют от dirname(baseDir) — ВЫШЕ песочницы — и подобрали бы маркер
  // родителя (напр. package.json рядом).
  const rel = relative(root, dir);
  if ((rel?.startsWith("..")) || isAbsolute(rel)) dir = root;
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
