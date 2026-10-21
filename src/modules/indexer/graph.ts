/**
 * Граф ссылок файл→файл и PageRank важности для карты проекта.
 *
 * Рёбра строятся из импортов/require (см. `extractImports`) с резолвом
 * локальных спецификаторов в проиндексированные файлы. PageRank даёт
 * «позвоночник» архитектуры: файл, на который ссылаются многие (и на который
 * ссылаются важные) — выше. Это сигнал для отбора файлов в блок промпта под
 * токен-бюджет (Aider repo-map), а не для поиска.
 */
import { dirname, join } from "path";
import type { IndexedFile } from "./walker";

/** Граф файлов: рёбра (импортёр → импортируемый) и PageRank-ранги. */
export interface FileGraph {
  edges: Map<string, Set<string>>;
  ranks: Map<string, number>;
}

/** Нормализует относительный путь к posix-виду для ключей графа. */
function norm(path: string): string {
  return path.replace(/\\/g, "/");
}

/** Отбрасывает расширение и хвостовой `/index`, чтобы матчить варианты импорта. */
function withoutExt(path: string): string {
  const p = path.replace(/\.[a-z0-9]+$/i, "");
  return p.replace(/\/index$/i, "");
}

/** Индекс путей для резолва спецификаторов импорта. */
class PathIndex {
  /** Ключ (путь без расширения) → файлы: коллизии хранятся списком. */
  private byKey = new Map<string, string[]>();

  constructor(files: IndexedFile[]) {
    for (const f of files) {
      const key = norm(f.path);
      this.add(withoutExt(key), key);
      this.add(key, key);
    }
  }

  /** Добавить файл под ключом (коллизия — список). */
  private add(key: string, file: string): void {
    const list = this.byKey.get(key);
    if (!list) {
      this.byKey.set(key, [file]);
      return;
    }
    if (!list.includes(file)) list.push(file);
  }

  /** Ищет файл по нормализованному кандидату (точное/с суффиксом). */
  lookup(candidate: string): string | null {
    const cand = withoutExt(candidate).replace(/^\.\//, "");
    if (!cand) return null;
    const exact = this.byKey.get(cand);
    if (exact) return exact[0] ?? null;
    const suffixed = this.byKey.get(`${cand}/index`);
    if (suffixed) return suffixed[0] ?? null;
    // Хвостовой матч: спецификатор `src/util` ↔ файл `packages/app/src/util.ts`.
    // Неоднозначный хвост (несколько файлов) — не берём ни один (аудит §8.8).
    const matches: string[] = [];
    for (const [key, list] of this.byKey) {
      if (key.endsWith(`/${cand}`)) matches.push(...list);
    }
    return matches.length === 1 ? (matches[0] ?? null) : null;
  }
}

/** Резолвит один спецификатор из файла-импортёра в файл индекса (или null). */
function resolveSpecifier(importer: string, spec: string, index: PathIndex): string | null {
  const s = spec.trim();
  if (!s || s.endsWith(".css") || s.endsWith(".scss") || s.endsWith(".json")) return null;
  if (s.startsWith("./") || s.startsWith("../")) {
    return index.lookup(norm(join(dirname(importer), s)));
  }
  if (s.startsWith("@/") || s.startsWith("~/")) {
    return index.lookup(s.replace(/^[@~/]+/, ""));
  }
  // Голый идентификатор пакета (`react`, `node:fs`) — это НЕ наш файл: не
  // сканируем всю карту (аудит §8.8).
  if (!s.includes("/") && !s.startsWith(".") && !s.startsWith("@") && !s.startsWith("~")) {
    return null;
  }
  // Голый/абсолютный спецификатор — пробуем как хвост пути (локальные пакеты).
  return index.lookup(s);
}

/** Базовая масса узлов на итерации. */
function initRank(nodes: string[], damping: number): Map<string, number> {
  const base = (1 - damping) / nodes.length;
  return new Map(nodes.map((node) => [node, base]));
}

/** Раздаёт ранг по рёбрам, возвращая накопленную dangling-массу. */
function distributeEdges(
  nodes: string[],
  edges: Map<string, Set<string>>,
  ranks: Map<string, number>,
  outDeg: Map<string, number>,
  damping: number,
  next: Map<string, number>,
): number {
  let dangling = 0;
  for (const node of nodes) {
    const deg = outDeg.get(node) ?? 0;
    const rank = ranks.get(node) ?? 0;
    if (deg === 0) {
      dangling += rank;
      continue;
    }
    const share = (damping * rank) / deg;
    for (const target of edges.get(node) ?? []) {
      next.set(target, (next.get(target) ?? 0) + share);
    }
  }
  return dangling;
}

/** Распределяет dangling-массу поровну по всем узлам. */
function spreadDangling(
  nodes: string[],
  dangling: number,
  damping: number,
  next: Map<string, number>,
): void {
  const spread = (damping * dangling) / nodes.length;
  for (const node of nodes) next.set(node, (next.get(node) ?? 0) + spread);
}

/** Одна итерация PageRank: вклад узлов по рёбрам + распределение dangling-массы. */
function rankIteration(
  nodes: string[],
  edges: Map<string, Set<string>>,
  ranks: Map<string, number>,
  outDeg: Map<string, number>,
  damping: number,
): Map<string, number> {
  const next = initRank(nodes, damping);
  const dangling = distributeEdges(nodes, edges, ranks, outDeg, damping, next);
  spreadDangling(nodes, dangling, damping, next);
  return next;
}

/** PageRank по графу (damping 0.85, 20 итераций; dangling-масса распределяется). */
export function pageRank(
  nodes: string[],
  edges: Map<string, Set<string>>,
  damping = 0.85,
  iterations = 20,
): Map<string, number> {
  if (nodes.length === 0) return new Map();
  const outDeg = new Map(nodes.map((node) => [node, edges.get(node)?.size ?? 0]));
  let ranks = new Map(nodes.map((node) => [node, 1 / nodes.length]));
  for (let it = 0; it < iterations; it++) {
    ranks = rankIteration(nodes, edges, ranks, outDeg, damping);
  }
  return ranks;
}

/** Строит граф ссылок и PageRank-ранги по проиндексированным файлам. */
export function buildFileGraph(files: IndexedFile[]): FileGraph {
  const nodes = files.map((f) => norm(f.path));
  const index = new PathIndex(files);
  const edges = new Map<string, Set<string>>();
  for (const node of nodes) edges.set(node, new Set());

  for (const file of files) {
    const from = norm(file.path);
    for (const spec of file.imports ?? []) {
      const target = resolveSpecifier(from, spec, index);
      if (target && target !== from) edges.get(from)?.add(target);
    }
  }

  return { edges, ranks: pageRank(nodes, edges) };
}
