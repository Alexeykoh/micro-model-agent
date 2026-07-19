import { resolve, relative, normalize, join, isAbsolute } from 'node:path';
import { existsSync, statSync, readdirSync } from 'node:fs';
import type { Dirent } from 'node:fs';

/**
 * Утилиты для работы с путями в fs-инструментах.
 *
 * Обеспечивают:
 * - Безопасное разрешение путей (относительно cwd)
 * - Предотвращение выхода за пределы проекта (path traversal)
 * - Форматирование размера файлов
 * - Обрезка вывода по лимитам
 *
 * @module tools/fs/path-utils
 */

// Игнорируемые директории (не сканируются)
export const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.mma', 'dist', 'build', '__pycache__',
  'vendor', '.next', '.nuxt', 'coverage', '.cache', 'target',
  'out', '.output', '.turbo',
]);

/**
 * Безопасно разрешает путь относительно cwd.
 * Предотвращает path traversal (выход за пределы проекта).
 */
export function resolvePath(
  userPath: string,
  cwd: string,
): { ok: true; abs: string; rel: string } | { ok: false; error: string } {
  if (!userPath || typeof userPath !== 'string') {
    return { ok: false, error: 'Path is required' };
  }

  const normalized = normalize(userPath.replace(/\//g, '\\'));
  const abs = isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
  const rel = relative(cwd, abs);

  if (rel.startsWith('..')) {
    return { ok: false, error: `Path escapes project root: ${userPath}` };
  }

  return { ok: true, abs, rel: rel.replace(/\\/g, '/') };
}

/** Проверяет существование файла/директории и его тип */
export function assertExists(
  abs: string,
  expectedType?: 'file' | 'dir',
): { ok: true; stat: ReturnType<typeof statSync> } | { ok: false; error: string; stat: undefined } {
  if (!existsSync(abs)) {
    return { ok: false, error: `Not found: ${abs}`, stat: undefined };
  }

  const stat = statSync(abs);

  if (expectedType === 'file' && !stat.isFile()) {
    return { ok: false, error: `Not a file: ${abs}`, stat: undefined };
  }
  if (expectedType === 'dir' && !stat.isDirectory()) {
    return { ok: false, error: `Not a directory: ${abs}`, stat: undefined };
  }

  return { ok: true, stat };
}

/** Форматирует размер файла (B, KB, MB) */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Нормализует путь (заменяет обратные слэши на прямые) */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Обрезает вывод по лимиту символов */
export function truncateOutput(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: text.slice(0, maxChars) + `\n... (truncated, ${text.length} total chars)`,
    truncated: true,
  };
}

/** Читает записи директории (с обработкой ошибок) */
export function readDirEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true }) as unknown as Dirent[];
  } catch {
    return [];
  }
}

/** Рекурсивно обходит директорию, пропуская IGNORE_DIRS и скрытые папки */
export function walkDirFiltered(
  dir: string,
  baseDir: string,
  callback: (filePath: string, relPath: string) => void,
  opts?: { maxResults?: number },
): number {
  let count = 0;
  const max = opts?.maxResults ?? Infinity;

  const entries = readDirEntries(dir);

  for (const entry of entries) {
    if (count >= max) break;
    const name = String(entry.name);
    if (IGNORE_DIRS.has(name) || name.startsWith('.')) continue;

    const fullPath = join(dir, name);
    if (entry.isDirectory()) {
      count += walkDirFiltered(fullPath, baseDir, callback, { maxResults: max - count });
    } else if (entry.isFile()) {
      const rel = normalizePath(fullPath.slice(baseDir.length + 1));
      callback(fullPath, rel);
      count++;
    }
  }

  return count;
}
