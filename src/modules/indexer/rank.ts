/**
 * Ранжирование результатов поиска по карте проекта.
 *
 * Definition-first, path-aware (как `pgr`/Zoekt): точное имя символа важнее
 * префикса, префикс важнее подстроки, символьное совпадение важнее файлового;
 * исходный код выше тестов, тесты выше доков/конфигов; при равенстве — мельче
 * путь и детерминированный алфавитный порядок. Ранжирование — единственный
 * рычаг, который реально улучшает первый результат для модели (см. бенчмарки
 * agentic search), поэтому оно вынесено отдельно и покрыто тестами.
 */
import type { IndexedFile } from "./walker";
import { isCodeLanguage } from "./symbols";

/** Совпадение по строке: 0 — точное, 1 — префикс, 2 — подстрока, -1 — нет. */
export function matchRank(haystack: string, query: string): number {
  const h = haystack.toLowerCase();
  if (h === query) return 0;
  if (h.startsWith(query)) return 1;
  if (h.includes(query)) return 2;
  return -1;
}

/** Класс файла: 0 — исходник, 1 — тест, 2 — док/конфиг. */
function fileClass(file: IndexedFile): number {
  const path = file.path.replace(/\\/g, "/").toLowerCase();
  if (
    path.startsWith("test/") ||
    path.startsWith("tests/") ||
    path.includes("/test/") ||
    path.includes("/tests/") ||
    path.includes("__tests__/") ||
    /\.(test|spec)\.[a-z0-9]+$/.test(path)
  ) {
    return 1;
  }
  return isCodeLanguage(file.language) ? 0 : 2;
}

/** Файл с вычисленным рангом (меньше — релевантнее). */
export interface RankedFile {
  file: IndexedFile;
  rank: number;
}

/** Лучший ранг совпадения имени символа в файле (-1 — нет). */
function bestSymbolRank(file: IndexedFile, q: string): number {
  let best = -1;
  for (const sym of file.symbols) {
    const r = matchRank(sym.name, q);
    if (r === 0) return 0;
    if (r > 0 && (best < 0 || r < best)) best = r;
  }
  return best;
}

/** Ранг совпадения по пути/имени файла со штрафом к символьным совпадениям. */
function pathFileRank(file: IndexedFile, q: string): number {
  const path = file.path.replace(/\\/g, "/");
  const base = path.split("/").pop() ?? path;
  const pathRank = matchRank(path, q);
  const baseRank = matchRank(base, q);
  return Math.min(pathRank < 0 ? 99 : pathRank + 3, baseRank < 0 ? 99 : baseRank + 3);
}

/** Детерминированный порядок: ранг → класс → длина пути → алфавит. */
function compareRanked(a: RankedFile, b: RankedFile): number {
  return (
    a.rank - b.rank ||
    fileClass(a.file) - fileClass(b.file) ||
    a.file.path.length - b.file.path.length ||
    a.file.path.localeCompare(b.file.path)
  );
}

/** Ранжирует файлы по совпадению символа/пути с запросом. */
export function rankFiles(files: IndexedFile[], query: string): RankedFile[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: RankedFile[] = [];
  for (const file of files) {
    let rank = bestSymbolRank(file, q);
    if (rank < 0) {
      const pathRank = pathFileRank(file, q);
      if (pathRank < 99) rank = pathRank;
    }
    if (rank >= 0) out.push({ file, rank });
  }
  return out.sort(compareRanked);
}

/** Символьное совпадение с файлом-носителем. */
export interface SymbolHit {
  file: IndexedFile;
  name: string;
  line: number;
  kind: string;
  signature?: string;
  rank: number;
}

/** Ранжирует отдельные символы по имени (definition-first). */
export function rankSymbols(files: IndexedFile[], query: string): SymbolHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: SymbolHit[] = [];
  for (const file of files) {
    for (const sym of file.symbols) {
      const rank = matchRank(sym.name, q);
      if (rank >= 0) {
        out.push({ file, name: sym.name, line: sym.line, kind: sym.kind, signature: sym.signature, rank });
      }
    }
  }
  return out.sort(
    (a, b) =>
      a.rank - b.rank ||
      fileClass(a.file) - fileClass(b.file) ||
      a.file.path.length - b.file.path.length ||
      a.file.path.localeCompare(b.file.path) ||
      a.line - b.line,
  );
}

/**
 * Отбирает файлы для блока карты по PageRank-важности под токен-бюджет.
 * Файлы без рёбер получают низкий ранг и идут последними; код всё равно выше
 * тестов/доков при равном ранге. Всегда берётся хотя бы один файл.
 */
export function selectByRank(
  files: IndexedFile[],
  ranks: Map<string, number>,
  maxTokens: number,
  estimate: (text: string) => number,
): IndexedFile[] {
  const ranked = [...files].sort((a, b) => {
    const ra = ranks.get(a.path.replace(/\\/g, "/")) ?? 0;
    const rb = ranks.get(b.path.replace(/\\/g, "/")) ?? 0;
    return (
      rb - ra ||
      fileClass(a) - fileClass(b) ||
      a.path.length - b.path.length ||
      a.path.localeCompare(b.path)
    );
  });
  const out: IndexedFile[] = [];
  let tokens = 0;
  for (const file of ranked) {
    const line = `- ${file.path.replace(/\\/g, "/")}: ${file.exports.join(", ")}`;
    const cost = estimate(line);
    if (out.length > 0 && tokens + cost > maxTokens) break;
    out.push(file);
    tokens += cost;
  }
  return out;
}

/** Находит файл для outline по пути/суффиксу/имени (null, если нет). */
export function matchOutline(files: IndexedFile[], query: string): IndexedFile | null {
  const q = query.trim().replace(/\\/g, "/").toLowerCase();
  if (!q) return null;
  const candidates = files.filter((file) => {
    const path = file.path.replace(/\\/g, "/").toLowerCase();
    const base = path.split("/").pop() ?? path;
    return path === q || path.endsWith(`/${q}`) || base === q || path.includes(q);
  });
  if (candidates.length === 0) return null;
  return candidates.sort(
    (a, b) =>
      fileClass(a) - fileClass(b) ||
      a.path.length - b.path.length ||
      a.path.localeCompare(b.path),
  )[0];
}
