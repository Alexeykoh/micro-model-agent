/** Утилиты путей: нормализация, jail-проверки, резолв от baseDir. */
import { resolve, normalize, dirname, basename, sep, relative, isAbsolute } from "path";
import { existsSync } from "fs";

/**
 * Бэкслэши → прямые слэши для показа и сравнения.
 * На POSIX no-op; на Windows `src\foo\bar.ts` → `src/foo/bar.ts`.
 */
export function toForwardSlash(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * True, если targetPath равен dirPath или внутри него.
 *
 * Кроссплатформенно:
 * - через path.relative(), а не raw startsWith: сосед с общим префиксом
 *   ("src" vs "src-other") не пройдёт;
 * - на Windows ФС регистронезависима: обе стороны lowercased до сравнения.
 */
export function isInsideDir(targetPath: string, dirPath: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const t = norm(resolve(targetPath));
  const d = norm(resolve(dirPath));
  if (t === d) return true;
  const rel = relative(d, t);
  // Побег наверх — только реальный `..`/`../…`. Файл буквально `..foo`
  // даёт rel === "..foo" и легально внутри.
  return rel.length > 0 && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

/**
 * True, если targetPath — сам scope-entry или внутри него. Проверка
 * сепараторов и регистра — как в isInsideDir.
 */
export function matchesScopeEntry(targetResolved: string, entryResolved: string): boolean {
  if (targetResolved === entryResolved) return true;
  return isInsideDir(targetResolved, entryResolved);
}

/**
 * Резолв пользовательского пути от baseDir.
 *
 * Чинит типовые ошибки модели:
 * 1. Ведущий слэш: "/testing/cat3" → относительно baseDir.
 * 2. Пропущенный сепаратор: "E:\agent_test" при baseDir "E:\agent\_test"
 *    → вставка недостающего бэкслэша.
 *
 * Для новых файлов обязан существовать родитель — проверяется он, а не
 * полный путь, иначе write_file не сработает.
 */
export function safeResolvePath(baseDir: string, userPath: string): string {
  // Существующий абсолютный путь — как есть.
  const asIs = resolve(normalize(userPath));
  if (userPath.startsWith("/") || userPath.startsWith("\\")) {
    if (existsSync(asIs) || existsSync(dirname(asIs))) return asIs;
  }

  const norm = normalize(userPath);

  // Абсолютные пути — дословно, БЕЗ сдирания ведущего слэша и перерезолва
  // от baseDir (иначе /var/folders/... станет baseDir/var/folders/... на POSIX).
  // Эвристика ведущего слэша ниже — только fallback, когда путь не на диске.
  if (isAbsolute(norm)) {
    if (existsSync(norm) || existsSync(dirname(norm))) return norm;
    // Абсолютный, но ещё не на диске (новый файл без существующих dirs).
    // Восстановление ошибки модели: ведущий слэш мог значить "от baseDir".
    const stripped = norm.replace(/^[/\\]/, "");
    const relativeCandidate = resolve(baseDir, stripped);
    if (existsSync(relativeCandidate) || existsSync(dirname(relativeCandidate))) {
      return relativeCandidate;
    }
    return norm;
  }

  const stripped = norm.replace(/^[/\\]/, "");
  const resolved = resolve(baseDir, stripped);

  // Быстрый путь: существует сам (или родитель для новых файлов).
  if (existsSync(resolved) || existsSync(dirname(resolved))) return resolved;

  const baseNorm = normalize(baseDir);

  // Подъём по предкам в поиске пропущенных сепараторов.
  let cur = baseNorm;
  while (cur && cur !== dirname(cur)) {
    const name = basename(cur);
    if (!name) {
      cur = dirname(cur);
      continue;
    }

    let idx = stripped.toLowerCase().indexOf(name.toLowerCase());
    while (idx >= 0) {
      const afterIdx = idx + name.length;
      const afterChar = stripped[afterIdx];

      if (afterChar && afterChar !== "\\" && afterChar !== "/") {
        const fixed = stripped.slice(0, afterIdx) + sep + stripped.slice(afterIdx);
        const fixedResolved = resolve(baseDir, normalize(fixed));
        if (existsSync(fixedResolved) || existsSync(dirname(fixedResolved))) {
          return fixedResolved;
        }
        // Проба от родителя предка.
        const fromParent = resolve(dirname(cur), normalize(fixed));
        if (existsSync(fromParent) || existsSync(dirname(fromParent))) {
          return fromParent;
        }
      }

      idx = stripped.toLowerCase().indexOf(name.toLowerCase(), idx + 1);
    }

    cur = dirname(cur);
  }

  return resolved;
}
