/**
 * Обход каталога документов (INV-D4/D5) и поддержание кэша в свежем состоянии.
 *
 * `indexDir` ходит по каталогу, резолвит файл через `buildRegistry`, парсит в
 * `DocumentIR` и чанкирует; неподдержанное/битое — пропуск со счётчиком, без
 * исключения. Нечитаемый **стартовый** каталог — не «пусто», а честная ошибка
 * (INV-D5). `refreshStale` пересобирает записи кэша, у которых изменился
 * `mtimeMs`/`size`, и отбрасывает исчезнувшие файлы.
 */
import { open, readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { Buffer } from "node:buffer";
import { join, relative, resolve, sep } from "node:path";
import { t } from "../../i18n/index";
import type { Logger } from "../../logger/app-logger";
import { chunkIR } from "./chunks";
import { parseCtx, type DocumentRegistry } from "./registry";
import { fileSource } from "./source";
import type { DocEntry } from "./cache";

export { CACHE_FILE, CACHE_VERSION, DocumentsCache } from "./cache";
export type { DocEntry, DocumentsCacheOptions } from "./cache";

/** Потолок числа документов за один обход (INV-D4). */
export const MAX_DOCUMENTS = 300;

/** Потолок глубины обхода каталога (INV-D4). */
export const MAX_INDEX_DEPTH = 6;

/** Общий потолок числа чанков корпуса за один обход (INV-D4). */
export const MAX_TOTAL_CHUNKS = 10_000;

/** Каталоги, в которые обход не заходит. */
const SKIP_DIRS = new Set([".git", "node_modules", ".mma"]);

/** Опции обхода каталога. */
export interface IndexDirOptions {
  baseDir: string;
  /** Каталог относительно `baseDir` (по умолчанию задаёт вызывающий). */
  dir: string;
  registry: DocumentRegistry;
  logger: Logger;
  maxDocuments?: number;
  maxDepth?: number;
  maxTotalChunks?: number;
  maxChunkChars?: number;
  maxChunksPerDoc?: number;
}

/** Итог обхода: записи, число пропусков и честный признак срабатывания капа. */
export interface IndexDirResult {
  entries: DocEntry[];
  skipped: number;
  truncated: boolean;
  /** Какой кап сработал (для честной заметки модели). */
  truncatedBy?: "documents" | "chunks";
  /** Дружелюбная причина, если стартовый каталог не читается (INV-D5). */
  error?: string;
}

/** Читает первые 8 байт файла для magic-detect (без полного чтения). */
async function readHead(path: string): Promise<Uint8Array> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(8);
    const { bytesRead } = await fh.read(buf, 0, 8, 0);
    return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * Обходит каталог и строит записи корпуса (INV-D4/D5). Ограничен по глубине,
 * числу документов и общему числу чанков; неподдержанные/битые файлы
 * пропускаются со счётчиком. Ни один битый файл не роняет обход. `truncated`
 * выставляется только когда кап реально отсёк индексируемый файл.
 */
export async function indexDir(opts: IndexDirOptions): Promise<IndexDirResult> {
  const baseDir = resolve(opts.baseDir);
  const start = resolve(baseDir, opts.dir);
  const maxDocs = Math.max(1, opts.maxDocuments ?? MAX_DOCUMENTS);
  const maxDepth = Math.max(0, opts.maxDepth ?? MAX_INDEX_DEPTH);
  const maxTotal = Math.max(1, opts.maxTotalChunks ?? MAX_TOTAL_CHUNKS);
  const chunkOpts = { maxChunkChars: opts.maxChunkChars, maxChunksPerDoc: opts.maxChunksPerDoc };
  const entries: DocEntry[] = [];
  let skipped = 0;
  let truncated = false;
  let truncatedBy: "documents" | "chunks" | undefined;
  let readError: string | undefined;
  let totalChunks = 0;

  const relOf = (abs: string): string => relative(baseDir, abs).split(sep).join("/");
  const atCap = (): boolean => entries.length >= maxDocs || totalChunks >= maxTotal;
  const capReason = (): "documents" | "chunks" => (totalChunks >= maxTotal ? "chunks" : "documents");

  /** Поддержан ли файл (без разбора): нужен, чтобы отличить реальный отсев от пропуска. */
  const isIndexable = async (abs: string): Promise<boolean> => {
    try {
      return opts.registry.resolve(abs, await readHead(abs)) !== null;
    } catch {
      return false;
    }
  };

  const handleFile = async (abs: string): Promise<void> => {
    try {
      const head = await readHead(abs);
      if (!opts.registry.resolve(abs, head)) {
        skipped += 1;
        return;
      }
      const ir = await opts.registry.parse(parseCtx(opts.logger), fileSource(baseDir, relOf(abs)));
      const st = await stat(abs);
      let chunks = chunkIR(ir, chunkOpts);
      const remaining = maxTotal - totalChunks;
      if (chunks.length > remaining) {
        chunks = chunks.slice(0, Math.max(0, remaining));
        truncated = true;
        truncatedBy = "chunks";
      }
      entries.push({
        path: abs,
        rel: relOf(abs),
        mtimeMs: st.mtimeMs,
        size: st.size,
        outline: ir.outline.map((n) => n.title),
        chunks,
      });
      totalChunks += chunks.length;
    } catch {
      skipped += 1;
    }
  };

  /** Возвращает `true`, если обход нужно немедленно прекратить (кап отсёк файл). */
  const walk = async (absDir: string, depth: number): Promise<boolean> => {
    let dirents: Dirent[];
    try {
      dirents = await readdir(absDir, { withFileTypes: true });
    } catch {
      // INV-D5: нечитаемый стартовый каталог не должен выглядеть пустым.
      if (depth === 0) readError = t("documents.dir_unreadable", { path: opts.dir });
      return false;
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirents) {
      const abs = join(absDir, d.name);
      if (d.isDirectory()) {
        if (SKIP_DIRS.has(d.name) || depth >= maxDepth) continue;
        if (await walk(abs, depth + 1)) return true;
      } else if (d.isFile()) {
        if (atCap()) {
          // Кап честен только если отсечённый файл реально был бы проиндексирован.
          if (await isIndexable(abs)) {
            truncated = true;
            truncatedBy = capReason();
            return true;
          }
          continue;
        }
        await handleFile(abs);
      }
    }
    return false;
  };

  await walk(start, 0);
  const result: IndexDirResult = { entries, skipped, truncated };
  if (truncatedBy) result.truncatedBy = truncatedBy;
  if (readError) result.error = readError;
  return result;
}

/** Опции пересборки протухших записей кэша. */
export interface RefreshStaleOptions {
  baseDir: string;
  registry: DocumentRegistry;
  logger: Logger;
  maxChunkChars?: number;
  maxChunksPerDoc?: number;
}

/** Итог пересборки: актуальные записи и число изменённых/удалённых. */
export interface RefreshStaleResult {
  entries: DocEntry[];
  changed: number;
}

/**
 * Пересобирает записи кэша по факту изменения файлов (INV-D4/D5): `stat` каждой
 * записи; исчезнувшие отбрасываются, изменившиеся (`mtimeMs`/`size`) заново
 * парсятся и чанкируются. Возвращает актуальный список и число изменений —
 * вызывающий сохраняет кэш, только если `changed > 0`.
 */
export async function refreshStale(
  entries: DocEntry[],
  opts: RefreshStaleOptions,
): Promise<RefreshStaleResult> {
  const chunkOpts = { maxChunkChars: opts.maxChunkChars, maxChunksPerDoc: opts.maxChunksPerDoc };
  const out: DocEntry[] = [];
  let changed = 0;
  for (const entry of entries) {
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(entry.path);
    } catch {
      changed += 1;
      continue; // файл исчез — запись уходит
    }
    if (st.mtimeMs === entry.mtimeMs && st.size === entry.size) {
      out.push(entry);
      continue;
    }
    try {
      const ir = await opts.registry.parse(parseCtx(opts.logger), fileSource(opts.baseDir, entry.rel));
      out.push({
        path: entry.path,
        rel: entry.rel,
        mtimeMs: st.mtimeMs,
        size: st.size,
        outline: ir.outline.map((n) => n.title),
        chunks: chunkIR(ir, chunkOpts),
      });
    } catch {
      // Стал неподдержанным/битым — запись уходит.
    }
    changed += 1;
  }
  return { entries: out, changed };
}
