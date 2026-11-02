// Glob-матчинг путей для политики `security.paths` (denied/allowed).
// Вынесен из `path-validator.ts`: матчер — самостоятельный шов, его правила
// (регистр, basename-паттерны) тестируются отдельно от проверки скоупа.
import { resolve, relative } from "path";
import { toForwardSlash } from "../../tools/path-utils";

/**
 * Регистр путей: на win32 ФС регистронезависима — сравниваем свёрнутыми.
 * На POSIX регистр значащий, поэтому паттерн `*.key` не должен ловить `A.KEY`.
 */
function foldCase(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

/** Экранирование regex-спецсимволов; glob-метасимволы обрабатываются отдельно. */
function escapeRegexChar(ch: string): string {
  return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * Glob → регулярка; на win32 — регистронезависимая.
 *
 * Грамматика:
 * - `**\/` — ноль и более сегментов (`a/**\/b` ловит и `a/b`, и `a/x/b`);
 * - `**` в конце (`src/**`) — сам каталог и всё под ним;
 * - `**` внутри — любые символы, включая `/`;
 * - `*` — в пределах сегмента, `?` — один символ;
 * - хвостовой `/` — каталог и всё под ним.
 *
 * Прежняя реализация разбирала `**` как «префикс + суффикс» и не понимала
 * шаблон вида `src/**\/*.ts` (суффикс сравнивался буквально): такие паттерны
 * молча не совпадали — и в конфиге, и в скоупе субагента.
 */
export function globToRegExp(pattern: string): RegExp {
  const folded = foldCase(toForwardSlash(pattern));
  const dirPattern = folded.endsWith("/");
  let body = dirPattern ? folded.slice(0, -1) : folded;
  // `src/**` должен совпадать и с самим `src` — иначе deny/скоуп-паттерн
  // пропускает каталог без детей (а обход дерева начинается с него).
  const tailRecursive = body.endsWith("/**");
  if (tailRecursive) body = body.slice(0, -"/**".length);

  let re = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "*" && body[i + 1] === "*") {
      i++;
      if (body[i + 1] === "/") {
        i++;
        re += "(?:[^/]+/)*";
      } else {
        re += ".*";
      }
      continue;
    }
    if (ch === "*") {
      re += "[^/]*";
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      continue;
    }
    re += escapeRegexChar(ch);
  }
  if (dirPattern || tailRecursive) re += "(?:/.*)?";
  return new RegExp(`^${re}$`, process.platform === "win32" ? "i" : "");
}

/** Есть ли совпадение хотя бы с одним паттерном списка. */
export function matchesAnyGlob(
  targetPath: string,
  baseDir: string,
  patterns: readonly string[],
): boolean {
  return patterns.some((pattern) => matchesGlobPattern(targetPath, baseDir, pattern));
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
  const foldedPattern = foldCase(toForwardSlash(pattern)).replace(/^\.\//, "");

  // Паттерн без сепаратора — шаблон имени файла (см. докблок): `*.key`
  // ловит и вложенные пути, иначе deny-паттерн обходился каталогом выше.
  if (!foldedPattern.includes("/")) {
    const basename = relPath.split("/").pop() ?? "";
    if (foldedPattern.includes("*") || foldedPattern.includes("?")) {
      return globToRegExp(foldedPattern).test(basename);
    }
    return basename === foldedPattern;
  }

  // Всё остальное — по относительному пути целиком.
  return globToRegExp(foldedPattern).test(relPath);
}
