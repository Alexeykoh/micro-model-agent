// Оркестратор скана корпуса (OO-4/OO-9): locate → partition → MAP(один файл
// через runChunkQuery) → рекурсивный REDUCE. Не третий движок: MAP/REDUCE
// переиспользуют runChunkQuery. Fanout ограничен; при переполнении — иерархия.
import type { LLMProvider } from "../../llm/provider";
import type { Logger } from "../../logger/app-logger";
import { errMsg } from "../../utils";
import { runChunkQuery } from "./chunk-query";

export interface ScanOptions {
  question: string;
  files: string[];
  readFile: (path: string) => string;
  /** Макс. веток MAP на уровне (OO-9). */
  maxFanout?: number;
  /** Макс. глубина партиции/редукции. */
  maxDepth?: number;
  maxParallel?: number;
  chunkChars?: number;
  logger?: Logger;
  sessionId?: string;
  signal?: AbortSignal;
}

export interface ScanFinding {
  path: string;
  answer: string;
}
export interface ScanResult {
  findings: ScanFinding[];
  synthesis: string;
  scanned: number;
  /** Глобальный пик одновременных MAP-вызовов за весь скан (для тестов/тюнинга). */
  maxFanoutObserved: number;
}

const DEFAULT_FANOUT = 8;
const DEFAULT_DEPTH = 3;

/** Простой семафор с очередью ожидания — единый гейт конкурентности скана. */
class Semaphore {
  private free: number;
  private readonly queue: Array<() => void> = [];
  constructor(limit: number) {
    this.free = Math.max(1, limit);
  }
  acquire(): Promise<void> {
    if (this.free > 0) {
      this.free--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }
  release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.free++;
  }
}

/** Общее для всего скана состояние: счётчики + глобальный гейт MAP. */
interface ScanState {
  scanned: number;
  maxFanoutObserved: number;
  inFlight: number;
  gate: Semaphore;
}

/** Группирует пути по каталогу (для иерархической партиции). */
function groupByDir(files: string[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const f of files) {
    const i = Math.max(f.lastIndexOf("/"), f.lastIndexOf("\\"));
    const dir = i >= 0 ? f.slice(0, i) : "";
    const arr = m.get(dir) ?? [];
    arr.push(f);
    m.set(dir, arr);
  }
  return m;
}

/** MAP одного файла: ответ на вопрос по его содержимому (runChunkQuery).
 * Конкурентность ограничена глобальным гейтом `state.gate`, общим для всех
 * уровней рекурсии, — иначе параллелизм умножался бы на каждом уровне. */
async function mapFile(
  provider: LLMProvider,
  path: string,
  opts: ScanOptions,
  maxParallel: number,
  state: ScanState,
): Promise<ScanFinding | null> {
  await state.gate.acquire();
  state.inFlight++;
  state.maxFanoutObserved = Math.max(state.maxFanoutObserved, state.inFlight);
  try {
    let text: string;
    try {
      text = opts.readFile(path);
    } catch (e) {
      opts.logger?.debug(`scanCorpus: skip ${path}: ${errMsg(e)}`);
      return null;
    }
    const r = await runChunkQuery(provider, text, opts.question, {
      synthesize: true,
      maxParallel,
      chunkChars: opts.chunkChars,
      logger: opts.logger,
      sessionId: opts.sessionId,
      signal: opts.signal,
    });
    return { path, answer: r.synthesis || r.answers.join("\n") };
  } finally {
    state.inFlight--;
    state.gate.release();
  }
}

async function mapLevel(
  provider: LLMProvider,
  files: string[],
  opts: ScanOptions,
  fanout: number,
  depth: number,
  state: ScanState,
): Promise<ScanFinding[]> {
  const maxParallel = Math.min(opts.maxParallel ?? fanout, fanout);
  // Иерархия (OO-9): корпус больше fanout → партиционируем по каталогам и рекурсируем.
  if (files.length > fanout && depth > 0) {
    const groups = groupByDir(files);
    const buckets = [...groups.values()];
    const out: ScanFinding[] = [];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(maxParallel, buckets.length) }, async () => {
      while (cursor < buckets.length) {
        const i = cursor++;
        const part = await mapLevel(provider, buckets[i], opts, fanout, depth - 1, state);
        out.push(...part);
      }
    });
    await Promise.all(workers);
    return out;
  }
  const out: ScanFinding[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(maxParallel, files.length) }, async () => {
    while (cursor < files.length) {
      const i = cursor++;
      const f = await mapFile(provider, files[i], opts, maxParallel, state);
      if (f) out.push(f);
    }
  });
  await Promise.all(workers);
  state.scanned += out.length;
  return out;
}

/** REDUCE: сводит находки; при переполнении — рекурсивно деревом. */
async function reduce(
  provider: LLMProvider,
  findings: ScanFinding[],
  opts: ScanOptions,
  fanout: number,
  depth: number,
): Promise<string> {
  if (findings.length === 0) return "";
  const text = findings.map((f) => `## ${f.path}\n${f.answer}`).join("\n\n");
  if (findings.length <= fanout || depth <= 0) {
    const r = await runChunkQuery(provider, text, opts.question, {
      synthesize: true,
      // Тот же кап, что и у MAP: внутренний параллелизм редукции не должен
      // множиться поверх глобального гейта.
      maxParallel: Math.max(1, opts.maxParallel ?? fanout),
      logger: opts.logger,
      sessionId: opts.sessionId,
      signal: opts.signal,
    });
    return r.synthesis || r.answers.join("\n");
  }
  // Разбить на группы по fanout и свести каждую, затем свести результаты.
  const groups: ScanFinding[][] = [];
  for (let i = 0; i < findings.length; i += fanout) groups.push(findings.slice(i, i + fanout));
  const partials: ScanFinding[] = [];
  for (const g of groups) {
    partials.push({
      path: `(${g.length} findings)`,
      answer: await reduce(provider, g, opts, fanout, depth - 1),
    });
  }
  return reduce(provider, partials, opts, fanout, depth - 1);
}

/** Скан корпуса: MAP по файлам + REDUCE. Возвращает находки и синтез. */
export async function scanCorpus(provider: LLMProvider, opts: ScanOptions): Promise<ScanResult> {
  const fanout = Math.max(1, opts.maxFanout ?? DEFAULT_FANOUT);
  const depth = Math.max(0, opts.maxDepth ?? DEFAULT_DEPTH);
  const cap = Math.max(1, opts.maxParallel ?? fanout);
  const state: ScanState = {
    scanned: 0,
    maxFanoutObserved: 0,
    inFlight: 0,
    gate: new Semaphore(cap),
  };
  const findings = await mapLevel(provider, opts.files, opts, fanout, depth, state);
  const synthesis = await reduce(provider, findings, opts, fanout, depth);
  return {
    findings,
    synthesis,
    scanned: state.scanned,
    maxFanoutObserved: state.maxFanoutObserved,
  };
}
