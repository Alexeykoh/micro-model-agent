// Glob-матчинг путей для политики `security.paths` (denied/allowed).
// Вынесен из `path-validator.ts`: матчер — самостоятельный шов, его правила
// (регистр, basename-паттерны) тестируются отдельно от проверки скоупа.
import { resolve, relative } from "path";
import { isInsideDir, toForwardSlash } from "../../tools/path-utils";

/**
 * Регистр путей: на win32 ФС регистронезависима — сравниваем свёрнутыми.
 * На POSIX регистр значащий, поэтому паттерн `*.key` не должен ловить `A.KEY`.
 */
function foldCase(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

/** Glob (`*`, `?`) → регулярка; на win32 — регистронезависимая. */
function globToRegExp(pattern: string): RegExp {
  const regexPattern = pattern
    .replace(/\*/g, "[^/\\\\]*")
    .replace(/\?/g, ".")
    .replace(/\./g, "\\.");
  return new RegExp(`^${regexPattern}$`, process.platform === "win32" ? "i" : "");
}

/**
 * Простой glob-матчинг (поддерживает * и **).
 *
 * Семантика:
 * - `**` — рекурсивно (любая глубина);
 * - паттерн БЕЗ сепаратора (`*.key`, `.env`, `package-lock.json`) — шаблон
 *   ИМЕНИ файла: ловит и вложенные пути (`certs/private.key`), иначе
 *   deny-паттерн обходился каталогом выше;
 * - паттерн с сепаратором — по сегментам относительного пути.
 */
export function matchesGlobPattern(targetPath: string, baseDir: string, pattern: string): boolean {
  const resolvedBaseDir = resolve(baseDir);
  const resolvedTargetPath = resolve(targetPath);

  // Относительный путь для посегментного матчинга. `relative`, а не
  // `startsWith`: на win32 регистр путей нечувствителен, и строковый
  // `startsWith` ронял бы сравнение (путь внутри baseDir выглядел бы
  // абсолютным — паттерн не срабатывал).
  const relPath = foldCase(toForwardSlash(relative(resolvedBaseDir, resolvedTargetPath)));
  const foldedPattern = foldCase(pattern);

  // Паттерны с ** (рекурсивный матчинг каталогов)
  if (foldedPattern.includes("**")) {
    const cleaned = foldedPattern.replace(/\/$/, "");
    const [rawPrefix, rawSuffix] = cleaned.split("**");
    const prefix = rawPrefix.replace(/\/$/, "");
    const suffix = rawSuffix.replace(/^\//, "");

    // Префикс: всё до ** обязано совпасть с началом пути
    if (prefix) {
      const prefixParts = prefix.split("/").filter(Boolean);
      const relParts = relPath.split("/");
      for (let i = 0; i < prefixParts.length; i++) {
        if (relParts[i] !== prefixParts[i]) return false;
      }
    }

    // ** в конце матчит всё
    if (!suffix) return true;

    // Суффикс против оставшихся сегментов
    const suffixParts = suffix.split("/").filter(Boolean);
    const relParts = relPath.split("/");
    for (
      let start = prefix ? prefix.split("/").filter(Boolean).length : 0;
      start <= relParts.length - suffixParts.length;
      start++
    ) {
      let match = true;
      for (let j = 0; j < suffixParts.length; j++) {
        if (suffixParts[j] === "*") continue;
        if (relParts[start + j] !== suffixParts[j]) {
          match = false;
          break;
        }
      }
      if (match) return true;
    }
    return false;
  }

  // Паттерны каталогов (с / на конце) без **
  if (foldedPattern.endsWith("/")) {
    const dirPattern = foldedPattern.slice(0, -1);
    const resolvedDirPattern = resolve(baseDir, dirPattern);
    return isInsideDir(resolvedTargetPath, resolvedDirPattern);
  }

  // Паттерн без сепаратора — шаблон имени файла (см. докблок).
  if (!foldedPattern.includes("/")) {
    const basename = relPath.split("/").pop() ?? "";
    if (foldedPattern.includes("*")) return globToRegExp(foldedPattern).test(basename);
    return basename === foldedPattern;
  }

  // Паттерн * (один уровень) с сепаратором
  if (foldedPattern.includes("*")) {
    return globToRegExp(foldedPattern).test(relPath);
  }

  // Точное совпадение (на win32 регистронезависимо — там FS такая)
  const exactTarget = resolve(baseDir, foldedPattern);
  if (process.platform === "win32") {
    return resolvedTargetPath.toLowerCase() === exactTarget.toLowerCase();
  }
  return resolvedTargetPath === exactTarget;
}
