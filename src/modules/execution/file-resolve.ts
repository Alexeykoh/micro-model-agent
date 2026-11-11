// Резолв файловых токенов плана: точный путь, суффикс пути, basename-fallback.
// Вынесено из `auditor.ts` (правило 6): явные контракты (`file-exists:`,
// `file-modified:`) не должны подтверждаться чужим basename (дефект A).
import { existsSync, readdirSync } from "fs";
import type { Dirent } from "fs";
import { resolve, join, basename } from "path";
import { SKIP_DIRS } from "./audit-runners";
import { toForwardSlash } from "../../tools/path-utils";

/** Кап глубины обхода поддерева для резолва файлов. */
const RESOLVE_MAX_DEPTH = 8;

/** Режим резолва файлового токена. */
export type FindExistingFileMode = "exact" | "suffix" | "fuzzy";

export interface FindExistingFileOptions {
  /**
   * Режим резолва:
   * - `"exact"` — только прямой резолв от baseDir;
   * - `"suffix"` — прямой + совпадение суффикса пути (`src/a.ts` находит
   *   `bicycle-shop/src/a.ts`), но НЕ чужой basename (`page.tsx` из другого
   *   каталога не подтверждает `src/app/cart/page.tsx`);
   * - `"fuzzy"` (по умолчанию) — прямой + суффикс + basename, обратная
   *   совместимость для токенов из описаний шагов.
   */
  mode?: FindExistingFileMode;
}

/**
 * Резолвит файловый токен шага плана в существующий файл.
 *
 * Описание шага часто называет файл голым basename ("App.tsx") или частично
 * префиксным путём ("src/App.tsx"), а реальный файл лежит во вложенной папке
 * проекта относительно baseDir агента (напр. `bicycle-shop/src/App.tsx`).
 * Наивный резолв от baseDir репортит файл пропавшим — было в ses_mssl5izw:
 * финальный audit-gate вечно реджектил полностью готовую задачу с "1 files
 * missing", загоняя модель в read/retry-петлю.
 */
export function findExistingFile(
  baseDir: string,
  filePath: string,
  opts: FindExistingFileOptions = {},
): string | null {
  const mode = opts.mode ?? "fuzzy";
  const direct = resolve(baseDir, filePath);
  if (existsSync(direct)) return direct;
  if (mode === "exact") return null;

  const name = basename(filePath).toLowerCase();
  const suffix = toForwardSlash(filePath).toLowerCase();
  let found: string | null = null;

  const walk = (dir: string, depth: number): void => {
    if (found || depth > RESOLVE_MAX_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(full, depth + 1);
      } else if (
        (mode === "fuzzy" && e.name.toLowerCase() === name) ||
        toForwardSlash(full).toLowerCase().endsWith(`/${suffix}`)
      ) {
        found = full;
        return;
      }
    }
  };

  walk(baseDir, 0);
  return found;
}
