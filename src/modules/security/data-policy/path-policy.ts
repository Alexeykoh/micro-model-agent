/**
 * Политика путей: два списка glob (D2) — `apiHiddenGlobs` (скрыто от API → 404) и
 * `providerBlockGlobs` (не отправлять внешнему). Матчинг — по **каноническому**
 * пути (`realpath`, INV-D10) и относительно workspace. Скоуп glob — только
 * `pathArgs` тулов, не произвольный текст (D6).
 */
import { realpathSync } from "node:fs";
import { resolve, relative } from "node:path";

/** Приводит путь к forward-slash, нижнему регистру, без ведущего «./». */
function normalize(rel: string): string {
  return rel.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

/** Glob → RegExp: `**` — любая глубина, `*` — в пределах сегмента, `?` — один символ. */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`(?:^|/)${out}(?:$|/)`, "i");
}

const cache = new Map<string, RegExp>();

/** Совпадает ли относительный путь с glob (нормализация обеих сторон). */
export function matchGlob(rel: string, glob: string): boolean {
  const g = normalize(glob);
  if (!g) return false;
  let re = cache.get(g);
  if (!re) {
    re = globToRegExp(g);
    cache.set(g, re);
  }
  const norm = normalize(rel);
  if (re.test(norm)) return true;
  // Паттерн-директория `.git/` → префикс.
  if (g.endsWith("/") && (norm === g.slice(0, -1) || norm.startsWith(g))) return true;
  return false;
}

/** Совпадает ли путь хотя бы с одним glob; возвращает совпавший glob или undefined. */
export function matchAnyGlob(rel: string, globs: readonly string[]): string | undefined {
  for (const g of globs) {
    if (matchGlob(rel, g)) return g;
  }
  return undefined;
}

/** Канонический путь (realpath, если существует) или absolute-resolve. */
export function canonicalize(target: string, baseDir: string): string {
  const abs = resolve(baseDir, target);
  try {
    return realpathSync.native(abs);
  } catch {
    return abs;
  }
}

/** Относительный (forward-slash, lower) путь к workspace. */
export function relativeTo(baseDir: string, abs: string): string {
  return normalize(relative(resolve(baseDir), abs));
}

/** Скрыт ли абсолютный/относительный путь от API и по какому glob. */
export function hiddenReason(
  target: string,
  baseDir: string,
  globs: readonly string[],
): string | undefined {
  const abs = canonicalize(target, baseDir);
  return matchAnyGlob(relativeTo(baseDir, abs), globs);
}
