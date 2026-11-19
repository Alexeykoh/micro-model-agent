// Отбор файлов для блока карты проекта: ранжирование код → тесты → доки.
import type { IndexedFile } from "./walker";
import { toForwardSlash } from "../../tools/path-utils";
import { isCodeLanguage } from "./symbols";

/** Локфайлы и генерированные манифесты: структурной ценности в карте нет. */
const NOISE_BASENAMES = new Set([
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "yarn.lock",
  "pnpm-lock.yaml",
  "cargo.lock",
  "go.sum",
  "composer.lock",
  "poetry.lock",
]);

/** True, если файл — локфайловый шум (не попадает в карту). */
export function isNoiseFile(file: IndexedFile): boolean {
  const base = toForwardSlash(file.path).split("/").pop()?.toLowerCase() ?? "";
  return NOISE_BASENAMES.has(base);
}

function isTestFile(path: string): boolean {
  return (
    path.startsWith("test/") ||
    path.startsWith("tests/") ||
    path.includes("/test/") ||
    path.includes("/tests/") ||
    path.includes("__tests__/") ||
    /\.(test|spec)\.[a-z0-9]+$/i.test(path)
  );
}

/** Ниже ранг — полезнее для понимания структуры проекта. */
function rank(file: IndexedFile): number {
  const path = toForwardSlash(file.path).toLowerCase();
  if (isTestFile(path)) return 1;
  if (isCodeLanguage(file.language)) return 0;
  return 2;
}

/** Верхний сегмент пути (`src/core/x.ts` → `src`; файл корня → его имя). */
function topDir(path: string): string {
  const normalized = toForwardSlash(path);
  const slash = normalized.indexOf("/");
  return slash >= 0 ? normalized.slice(0, slash) : normalized;
}

/** Сколько файлов исходного кода под каждым верхнеуровневым каталогом. */
function codeCountByTopDir(files: IndexedFile[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    if (isNoiseFile(file) || rank(file) !== 0) continue;
    const dir = topDir(file.path);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return counts;
}

/**
 * Выбирает файлы для блока карты проекта в промпте.
 *
 * Индекс строится произвольным обходом `readdir`, так что наивный
 * `files.slice(0, N)` может перечислить одни доки, конфиги и тесты, а реальное
 * дерево исходников (`src/`) не показать — модель увидит "карту проекта" без
 * кода. Отбор:
 *   1. выкидывает локфайловый шум,
 *   2. ранжирует исходники выше тестов, тесты выше доков/конфигов,
 *   3. внутри ранга первыми — каталоги с плотнейшим кодом (плотнейший корень
 *      почти всегда настоящее дерево исходников — имён каталогов не захардкожено),
 *   4. затем мельче пути, затем алфавит — детерминированно, чтобы блок не
 *      менялся между ходами и выживал префиксный KV-кэш.
 */
export function selectMapFiles(files: IndexedFile[], max: number): IndexedFile[] {
  const codeByDir = codeCountByTopDir(files);
  return files
    .filter((file) => !isNoiseFile(file))
    .sort((a, b) => {
      const rankDiff = rank(a) - rank(b);
      if (rankDiff !== 0) return rankDiff;
      const densityDiff =
        (codeByDir.get(topDir(b.path)) ?? 0) - (codeByDir.get(topDir(a.path)) ?? 0);
      if (densityDiff !== 0) return densityDiff;
      const pathA = toForwardSlash(a.path);
      const pathB = toForwardSlash(b.path);
      const depthDiff = pathA.split("/").length - pathB.split("/").length;
      if (depthDiff !== 0) return depthDiff;
      return pathA < pathB ? -1 : pathA > pathB ? 1 : 0;
    })
    .slice(0, max);
}
