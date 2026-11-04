// Ignore rules for the project walker, shared by the web file tree and grep.

const IGNORE_DIRS = new Set([
  // VCS / MMA
  ".git",
  ".hg",
  ".svn",
  ".mma",
  // Каталоги dev/agent/тулинга MMA — не исходники проекта (зеркало .gitignore:
  // карта dev-чекаута не тонет в тестовых песочницах / агентском скратче).
  "_testing",
  ".superpowers",
  ".opencode",
  ".fallow",
  // Node / JS-бандлеры
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  ".cache",
  // Python
  "venv",
  ".venv",
  "env",
  "virtualenv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  "site-packages",
  // Rust
  "target",
  // Go / PHP / Ruby
  "vendor",
  ".bundle",
  // JVM
  ".gradle",
  "out",
  // .NET
  "obj",
  // Apple
  "pods",
  "deriveddata",
  // IDE / редакторы
  ".idea",
  ".vscode",
]);

/** True, если имя каталога игнорируется (регистронезависимо). */
export function isIgnoredDirName(name: string): boolean {
  return IGNORE_DIRS.has(name.toLowerCase());
}

/** Локфайлы — генерированы, не исходники проекта. */
const IGNORE_FILE_NAMES = new Set([
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "yarn.lock",
  "pnpm-lock.yaml",
  // Вендоренные веб-бандлы (минифицированы; их символы — шум).
  "hljs.js",
  "smd.js",
]);

/** Семейства конфигов/бейзлайнов тулинга — не исходники проекта. */
const IGNORE_FILE_PREFIXES = [".fallow"];

/** True, если имя файла игнорируется (регистронезависимый префикс/точное совпадение). */
export function isIgnoredFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    IGNORE_FILE_NAMES.has(lower) ||
    lower.endsWith(".min.js") ||
    IGNORE_FILE_PREFIXES.some((p) => lower.startsWith(p))
  );
}

/**
 * True, если ЛЮБОЙ СЕГМЕНТ пути — игнорируемый каталог. Посегментно (не
 * подстрока): короткие имена `env`/`out`/`obj` не должны вычёркивать
 * `environment.ts` или `about/`.
 */
export function isIgnoredPath(filename: string): boolean {
  const segments = filename.split(/[\\/]/);
  const base = segments[segments.length - 1] ?? "";
  return segments.some((segment) => isIgnoredDirName(segment)) || isIgnoredFileName(base);
}

/** Один проиндексированный файл: путь, язык, символы, размер, mtime. */
