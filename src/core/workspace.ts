/** Резолвинг путей workspace: поиск корня проекта по манифестам. */
import { existsSync, readdirSync } from "fs";
import { resolve, isAbsolute, join } from "path";

/** Файлы/каталоги — маркеры корня проекта. */
const PROJECT_MANIFESTS = [
  "package.json",
  "bun.lockb",
  "bun.lock",
  "yarn.lock",
  "pnpm-lock.yaml",
  "go.mod",
  "Cargo.toml",
  "pyproject.toml",
  "requirements.txt",
  "Gemfile",
  "composer.json",
];

/** Подкаталоги, никогда не кандидаты в корень проекта. */
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".hg", ".svn"]);

const subdirCache = new Map<string, string[]>();

function scanSubdirs(baseDir: string): string[] {
  const cached = subdirCache.get(baseDir);
  if (cached) return cached;
  let dirs: string[] = [];
  try {
    dirs = readdirSync(baseDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .filter((name) => !SKIP_DIRS.has(name));
  } catch {
    dirs = [];
  }
  if (dirs.length > 0) subdirCache.set(baseDir, dirs);
  return dirs;
}

/**
 * Есть ли в каталоге манифест проекта.
 * @param dir каталог для проверки.
 * @returns true, если найден известный манифест.
 */
export function hasProjectManifest(dir: string): boolean {
  return PROJECT_MANIFESTS.some((m) => existsSync(join(dir, m)));
}

/**
 * Резолвит путь внутри workspace. Терпит запуск из родителя, когда проект
 * лежит в одном подкаталоге (baseDir=<repo>, проект=<repo>/app). Порядок:
 *   1. абсолютный путь как есть;
 *   2. baseDir/<p> — проект прямо в baseDir;
 *   3. <subdir>/<p> по подкаталогам (приоритет — с манифестом).
 * Фолбэк — baseDir/<p>, чтобы вызывающий через existsSync() корректно
 * определил отсутствие пути.
 * @param baseDir корень workspace; @param p относительный/абсолютный путь.
 */
export function resolveProjectPath(baseDir: string, p: string): string {
  const abs = isAbsolute(p) ? p : resolve(baseDir, p);
  if (existsSync(abs)) return abs;

  // Сам baseDir — корень проекта: подкаталоги не сканируем, иначе
  // зацепим файлы посторонних вложенных пакетов.
  if (hasProjectManifest(baseDir)) return abs;

  let fallback = abs;
  for (const name of scanSubdirs(baseDir)) {
    const candidate = resolve(baseDir, name, p);
    if (existsSync(candidate)) {
      if (hasProjectManifest(join(baseDir, name))) return candidate;
      if (fallback === abs) fallback = candidate;
    }
  }
  return fallback;
}

/** Сбрасывает кэш подкаталогов (нужен тестам). */
export function clearWorkspaceCache(): void {
  subdirCache.clear();
}
