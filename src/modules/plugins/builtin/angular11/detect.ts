// Детект Angular-воркспейса и мажорной версии фреймворка (плагин `angular11`).
//
// Маркер — `angular.json` вверх по дереву от рабочего каталога: та же логика,
// что у LSP-роутинга (`src/modules/lsp/config.ts`), но без зависимости от LSP,
// чтобы плагин оставался автономным и отключаемым.
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";

const ANGULAR_MARKER = "angular.json";
const LOOKUP_DEPTH = 10;

/** Ближайший каталог с `angular.json` вверх от `startDir`; null — не Angular-воркспейс. */
export function findAngularRoot(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < LOOKUP_DEPTH; i++) {
    if (existsSync(join(dir, ANGULAR_MARKER))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Лежит ли каталог внутри Angular-воркспейса. */
export function isAngularProject(startDir: string): boolean {
  return findAngularRoot(startDir) !== null;
}

/** Содержимое `package.json` каталога; null — файла нет или он нечитаем. */
function readPackageJson(dir: string): { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    return JSON.parse(readFileSync(pkgPath, "utf-8"));
  } catch {
    return null;
  }
}

/** Мажорная версия из semver-строки (`^11.2.0` → 11, `~4.0.5` → 4). */
function majorOf(range: string | undefined): number | null {
  if (!range) return null;
  const match = range.match(/(\d+)\./);
  if (!match) return null;
  const major = Number.parseInt(match[1], 10);
  return Number.isNaN(major) ? null : major;
}

/**
 * Мажорная версия `@angular/core` из ближайшего `package.json`; null — не найден.
 * Версии из `dependencies` и `devDependencies` равнозначны.
 */
export function angularMajorVersion(startDir: string): number | null {
  const root = findAngularRoot(startDir) ?? startDir;
  const pkg = readPackageJson(root);
  if (!pkg) return null;
  const range = pkg.dependencies?.["@angular/core"] ?? pkg.devDependencies?.["@angular/core"];
  return majorOf(range);
}
