// Контракт записи скоупа субагента: каталог/файл, glob или «весь workspace».
//
// Вынесен из `path-utils.ts`: прежний `matchesScopeEntry` сравнивал префиксы
// и не понимал glob (`src/**/*` резолвился в несуществующий путь и не
// совпадал ни с чем — субагент не читал ни одного файла). Спека:
// `docs/specs/2026-11-02-subagent-scope-entries-design.md`.
import { resolve } from "path";
import { isInsideDir, toForwardSlash } from "../../tools/path-utils";
import { globToRegExp, matchesGlobPattern } from "./path-glob";

/** Максимум записей скоупа, показываемых в причине отказа. */
const MAX_SHOWN_ENTRIES = 5;

/** Есть ли в записи glob-метасимволы (`*`, `?`). */
export function isScopeGlob(entry: string): boolean {
  return entry.includes("*") || entry.includes("?");
}

/**
 * Нормализация записи скоупа: слэши, `./`, `//`, хвостовой `/`.
 * Идемпотентна. Невалидность проверяется отдельно (`invalidScopeEntry`).
 */
export function normalizeScopeEntry(raw: string): string {
  const trimmed = raw.trim();
  // UNC (`\\server\share`) не схлопываем: `//` там — часть пути, не мусор.
  const isUnc = /^[\\/]{2}[^\\/]/.test(trimmed);
  const slashed = isUnc
    ? trimmed.replace(/\\/g, "/")
    : trimmed.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  const stripped = slashed.replace(/^\.\//, "").replace(/\/+$/, "");
  return stripped === "." ? "" : stripped;
}

/** Абсолютная запись (POSIX-корень, `C:/…`, UNC) — цель сверяется как есть. */
export function isAbsoluteScopeEntry(entry: string): boolean {
  return entry.startsWith("/") || /^[a-zA-Z]:\//.test(entry);
}

/**
 * Почему запись невалидна. Пустая строка — «валидна» (нет причины).
 *
 * Отсекаются: пустая запись, `.` и `..`-сегмент. Абсолютная запись легальна
 * (A10): при `security.paths.enabled=false` она выражает доступ вне baseDir —
 * это явное намерение, а не побег по ошибке.
 */
export function invalidScopeEntry(normalized: string): string | undefined {
  if (!normalized) return "empty entry";
  if (normalized.split("/").includes("..")) return "'..' is not allowed in scope entries";
  return undefined;
}

/**
 * Нормализовать список записей и отделить невалидные.
 * Порядок сохраняется, дубликаты схлопываются.
 */
export function normalizeScopeEntries(list: readonly string[]): {
  entries: string[];
  invalid: Array<{ raw: string; reason: string }>;
} {
  const entries: string[] = [];
  const invalid: Array<{ raw: string; reason: string }> = [];
  for (const raw of list) {
    const normalized = normalizeScopeEntry(raw);
    const reason = invalidScopeEntry(normalized);
    if (reason) {
      invalid.push({ raw, reason });
      continue;
    }
    if (!entries.includes(normalized)) entries.push(normalized);
  }
  return { entries, invalid };
}

/**
 * Цель внутри записи скоупа?
 *
 * - glob (`*`, `?`, `**`) — по правилам `security.paths` (`matchesGlobPattern`);
 * - иначе — прежняя семантика: совпадение или вложенность.
 *
 * Запись `**` означает «весь workspace»: джейл baseDir всё равно проверяется
 * раньше (`isPathInScope`), поэтому запись не расширяет границу.
 */
export function matchesScopeEntry(targetResolved: string, entry: string, baseDir: string): boolean {
  const normalized = normalizeScopeEntry(entry);
  if (invalidScopeEntry(normalized)) return false;
  if (isAbsoluteScopeEntry(normalized)) {
    if (isScopeGlob(normalized)) {
      const targetSlash = toForwardSlash(resolve(targetResolved));
      if (globToRegExp(normalized).test(targetSlash)) return true;
      // win32: POSIX-абсолютная запись `/opt/x` означает `C:/opt/x`.
      return (
        process.platform === "win32" &&
        normalized.startsWith("/") &&
        globToRegExp(normalized).test(targetSlash.replace(/^[a-zA-Z]:/, ""))
      );
    }
    return isInsideDir(targetResolved, resolve(normalized));
  }
  if (isScopeGlob(normalized)) return matchesGlobPattern(targetResolved, baseDir, normalized);
  return isInsideDir(targetResolved, resolve(baseDir, normalized));
}

/** Состав скоупа для текста причины: до 5 записей, дальше «+N more». */
export function formatScopeEntries(entries: readonly string[]): string {
  const shown = entries.slice(0, MAX_SHOWN_ENTRIES);
  const rest = entries.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} +${rest} more` : shown.join(", ");
}

/**
 * Причина отказа по скоупу — с составом записей (INV-S4): модель должна
 * видеть, что именно ей разрешено, а не гадать «файла нет?».
 */
export function scopeReason(
  kind: "allowed" | "writable",
  allowed: readonly string[],
  readOnly: readonly string[] = [],
): string {
  const entries = allowed.length > 0 ? allowed : readOnly;
  const head =
    kind === "writable"
      ? "Path is not within the writable scope for this sub-agent"
      : "Path is not within the allowed scope for this sub-agent";
  return entries.length > 0 ? `${head} (scope: ${formatScopeEntries(entries)})` : head;
}
