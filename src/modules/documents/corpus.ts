/**
 * Обход каталога документов (INV-D4/D5) и поддержание кэша в свежем состоянии.
 *
 * `inventoryDir` обходит каталог и собирает индексируемые файлы (path/rel/
 * mtimeMs/size) **без разбора**; `buildEntries` парсит и чанкует их в записи
 * корпуса. `reconcile` сводит инвентарь с кэшем: неизменившиеся записи
 * переиспользуются, добавленные/изменённые пересобираются, исчезнувшие
 * отбрасываются. Нечитаемый **стартовый** каталог — не «пусто», а честная ошибка
 * (INV-D5).
 */
import { open, readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
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

/** Элемент инвентаря: индексируемый файл без разбора (INV-D4). */
export interface InventoryItem {
  /** Абсолютный путь (для чтения/enforcement, не для сообщений модели). */
  path: string;
  /** Путь относительно `baseDir` (forward-slash) — для модели и `document_read`. */
  rel: string;
  mtimeMs: number;
  size: number;
}

/** Общие ограничители обхода. */
export interface WalkLimits {
  maxDocuments?: number;
  maxDepth?: number;
}

/** Опции инвентаризации каталога. */
export interface InventoryDirOptions extends WalkLimits {
  registry: DocumentRegistry;
  logger: Logger;
}

/** Итог инвентаризации: файлы, число пропусков и честный признак капа. */
export interface InventoryDirResult {
  items: InventoryItem[];
  skipped: number;
  truncated: boolean;
  truncatedBy?: "documents";
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
 * Обходит каталог и собирает индексируемые файлы без разбора (INV-D4/D5).
 * Ограничен по глубине и числу документов; неподдержанные/нечитаемые файлы
 * пропускаются со счётчиком. Ни один битый файл не роняет обход. `truncated`
 * выставляется только когда кап реально отсёк индексируемый файл.
 */
export async function inventoryDir(
  baseDir: string,
  dir: string,
  opts: InventoryDirOptions,
): Promise<InventoryDirResult> {
  const base = resolve(baseDir);
  const start = resolve(base, dir);
  const maxDocs = Math.max(1, opts.maxDocuments ?? MAX_DOCUMENTS);
  const maxDepth = Math.max(0, opts.maxDepth ?? MAX_INDEX_DEPTH);
  const items: InventoryItem[] = [];
  let skipped = 0;
  let truncated = false;
  let readError: string | undefined;

  const relOf = (abs: string): string => relative(base, abs).split(sep).join("/");

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
      if (opts.registry.resolve(abs, await readHead(abs)) === null) {
        skipped += 1;
        return;
      }
      const st = await stat(abs);
      items.push({ path: abs, rel: relOf(abs), mtimeMs: st.mtimeMs, size: st.size });
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
      if (depth === 0) readError = t("documents.dir_unreadable", { path: dir });
      return false;
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirents) {
      const abs = join(absDir, d.name);
      if (d.isDirectory()) {
        if (SKIP_DIRS.has(d.name) || depth >= maxDepth) continue;
        if (await walk(abs, depth + 1)) return true;
      } else if (d.isFile()) {
        if (items.length >= maxDocs) {
          // Кап честен только если отсечённый файл реально был бы проиндексирован.
          if (await isIndexable(abs)) {
            truncated = true;
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
  const result: InventoryDirResult = { items, skipped, truncated };
  if (truncated) result.truncatedBy = "documents";
  if (readError) result.error = readError;
  return result;
}

/** Опции сборки записей из инвентаря. */
export interface BuildEntriesOptions {
  baseDir: string;
  registry: DocumentRegistry;
  logger: Logger;
  maxTotalChunks?: number;
  maxChunkChars?: number;
  maxChunksPerDoc?: number;
}

/** Итог сборки: записи, число пропусков и признак срабатывания бюджета чанков. */
export interface BuildEntriesResult {
  entries: DocEntry[];
  skipped: number;
  chunkTruncated: boolean;
}

/**
 * Парсит и чанкует элементы инвентаря в записи корпуса (INV-D4). Общий бюджет
 * чанков ограничивает суммарное число; лишние чанки отбрасываются с честным
 * признаком. Битый файл — пропуск со счётчиком, не исключение.
 */
export async function buildEntries(
  items: InventoryItem[],
  opts: BuildEntriesOptions,
): Promise<BuildEntriesResult> {
  const maxTotal = Math.max(1, opts.maxTotalChunks ?? MAX_TOTAL_CHUNKS);
  const chunkOpts = { maxChunkChars: opts.maxChunkChars, maxChunksPerDoc: opts.maxChunksPerDoc };
  const entries: DocEntry[] = [];
  let skipped = 0;
  let totalChunks = 0;
  let chunkTruncated = false;
  for (const it of items) {
    if (totalChunks >= maxTotal) {
      chunkTruncated = true;
      break;
    }
    try {
      const ir = await opts.registry.parse(parseCtx(opts.logger), fileSource(opts.baseDir, it.rel));
      let chunks = chunkIR(ir, chunkOpts);
      const remaining = maxTotal - totalChunks;
      if (chunks.length > remaining) {
        chunks = chunks.slice(0, Math.max(0, remaining));
        chunkTruncated = true;
      }
      entries.push({
        path: it.path,
        rel: it.rel,
        mtimeMs: it.mtimeMs,
        size: it.size,
        outline: ir.outline.map((n) => n.title),
        chunks,
      });
      totalChunks += chunks.length;
    } catch {
      skipped += 1;
    }
  }
  return { entries, skipped, chunkTruncated };
}

/** Опции обхода каталога. */
export interface IndexDirOptions extends WalkLimits {
  baseDir: string;
  dir: string;
  registry: DocumentRegistry;
  logger: Logger;
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
  /** Отпечаток инвентаря — честная сигнатура кэша. */
  signature: string;
  /** Дружелюбная причина, если стартовый каталог не читается (INV-D5). */
  error?: string;
}

/**
 * Обходит каталог и строит записи корпуса (INV-D4/D5): `inventoryDir` собирает
 * индексируемые файлы, `buildEntries` парсит и чанкует их. Ни один битый файл не
 * роняет обход. `truncated` честен: кап документов или бюджет чанков.
 */
export async function indexDir(opts: IndexDirOptions): Promise<IndexDirResult> {
  const inv = await inventoryDir(opts.baseDir, opts.dir, opts);
  const built = await buildEntries(inv.items, opts);
  const truncated = inv.truncated || built.chunkTruncated;
  const truncatedBy = inv.truncated ? "documents" : built.chunkTruncated ? "chunks" : undefined;
  const result: IndexDirResult = {
    entries: built.entries,
    skipped: inv.skipped + built.skipped,
    truncated,
    signature: fingerprint(inv.items),
  };
  if (truncatedBy) result.truncatedBy = truncatedBy;
  if (inv.error) result.error = inv.error;
  return result;
}

/** Дешёвый отпечаток инвентаря (`rel:mtime:size`) — честная сигнатура кэша. */
export function fingerprint(items: InventoryItem[]): string {
  const hash = createHash("sha1");
  for (const it of items) hash.update(`${it.rel}:${it.mtimeMs}:${it.size}\n`);
  return hash.digest("hex");
}
