/**
 * Дисковый кэш корпуса документов (INV-D4/D5) и ограниченный обход каталога.
 *
 * По образцу `src/modules/indexer/cache.ts`, но **изолирован** от индексатора
 * кода: свой файл (`documents-cache.json`), свой envelope и своя валидация.
 * Чужой/битый/старого формата кэш **игнорируется**, а не доверяется. `indexDir`
 * ходит по каталогу, резолвит файл через `buildRegistry`, парсит в `DocumentIR`
 * и чанкирует; неподдержанное/битое — пропуск со счётчиком, без исключения.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { readFileSync, writeFileSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { join, relative, resolve, sep } from "node:path";
import type { Logger } from "../../logger/app-logger";
import { chunkIR, type DocChunk } from "./chunks";
import { parseCtx, type DocumentRegistry } from "./registry";
import { fileSource } from "./source";

/** Версия схемы кэша: инкремент делает старые кэши протухшими. */
export const CACHE_VERSION = 1;

/** Имя файла кэша корпуса рядом с `index-cache.json`. */
export const CACHE_FILE = "documents-cache.json";

/** Потолок числа документов за один обход (INV-D4). */
export const MAX_DOCUMENTS = 300;

/** Потолок глубины обхода каталога (INV-D4). */
export const MAX_INDEX_DEPTH = 6;

/** Каталоги, в которые обход не заходит. */
const SKIP_DIRS = new Set([".git", "node_modules", ".mma"]);

/** Запись корпуса: файл + метаданные + оглавление + чанки. */
export interface DocEntry {
  /** Абсолютный путь (для чтения/enforcement, не для сообщений модели). */
  path: string;
  /** Путь относительно `baseDir` (forward-slash) — для модели и `document_read`. */
  rel: string;
  mtimeMs: number;
  size: number;
  outline: string[];
  chunks: DocChunk[];
}

/** Дисковая обёртка с метаданными валидации вокруг записей корпуса. */
interface CacheEnvelope {
  version: number;
  /** Абсолютный корень проиндексированного каталога. */
  root: string;
  signature: string;
  builtAt?: number;
  entries: DocEntry[];
}

/** Опции кэша корпуса. */
export interface DocumentsCacheOptions {
  /** Абсолютный корень; кэш под другой root отвергается. */
  root?: string;
  /** Текущая сигнатура дерева; при расхождении кэш отвергается. */
  signature?: () => string;
}

/** Проверяет форму одного чанка. */
function isChunk(v: unknown): v is DocChunk {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return typeof c.id === "string" && typeof c.text === "string" && (c.section === undefined || typeof c.section === "string");
}

/** Проверяет форму одной записи корпуса. */
function isEntry(v: unknown): v is DocEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.path === "string" &&
    typeof e.rel === "string" &&
    typeof e.mtimeMs === "number" &&
    typeof e.size === "number" &&
    Array.isArray(e.outline) &&
    e.outline.every((t) => typeof t === "string") &&
    Array.isArray(e.chunks) &&
    e.chunks.every(isChunk)
  );
}

/** Дисковый кэш корпуса с валидацией версии/root/сигнатуры/формы. */
export class DocumentsCache {
  private readonly cachePath: string;
  private cache: DocEntry[] | null = null;
  private readonly root: string | undefined;
  private readonly signature: (() => string) | undefined;

  constructor(cacheDir: string, opts: DocumentsCacheOptions = {}) {
    this.cachePath = join(cacheDir, CACHE_FILE);
    this.root = opts.root;
    this.signature = opts.signature;
  }

  /**
   * Разбирает envelope и проверяет версию/root/форму. Чужой формат, битый JSON
   * или частично записанный файл — `null` (кэш отвергается, не доверяется).
   */
  private readEnvelope(): DocEntry[] | null {
    if (!existsSync(this.cachePath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.cachePath, "utf-8")) as Partial<CacheEnvelope>;
      if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) return null;
      if (!parsed.entries.every(isEntry)) return null;
      if (this.root !== undefined && parsed.root !== this.root) return null;
      if (this.signature && this.currentSignature() !== (parsed.signature ?? "")) return null;
      return parsed.entries;
    } catch {
      return null;
    }
  }

  /** Загружает записи, только если кэш валиден; иначе `null` (полная пересборка). */
  load(): DocEntry[] | null {
    if (this.cache) return this.cache;
    const entries = this.readEnvelope();
    if (entries) this.cache = entries;
    return entries;
  }

  /** Сохраняет записи в кэш (память + диск). */
  save(entries: DocEntry[]): void {
    this.cache = entries;
    const envelope: CacheEnvelope = {
      version: CACHE_VERSION,
      root: this.root ?? "",
      signature: this.currentSignature(),
      builtAt: Date.now(),
      entries,
    };
    if (!existsSync(join(this.cachePath, ".."))) mkdirSync(join(this.cachePath, ".."), { recursive: true });
    writeFileSync(this.cachePath, JSON.stringify(envelope), "utf-8");
  }

  /** Инвалидирует кэш (память + дисковый файл). */
  invalidate(): void {
    this.cache = null;
    if (existsSync(this.cachePath)) {
      try {
        rmSync(this.cachePath);
      } catch {
        /* best-effort очистка */
      }
    }
  }

  /** Сигнатура защищённо: нечитаемое дерево даёт строку, не совпадающую с сохранённой. */
  private currentSignature(): string {
    if (!this.signature) return "";
    try {
      return this.signature();
    } catch {
      return "";
    }
  }
}

/** Опции обхода каталога. */
export interface IndexDirOptions {
  baseDir: string;
  /** Каталог относительно `baseDir` (по умолчанию задаёт вызывающий). */
  dir: string;
  registry: DocumentRegistry;
  logger: Logger;
  maxDocuments?: number;
  maxDepth?: number;
  maxChunkChars?: number;
  maxChunksPerDoc?: number;
}

/** Итог обхода: записи, число пропусков и факт срабатывания капа. */
export interface IndexDirResult {
  entries: DocEntry[];
  skipped: number;
  truncated: boolean;
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
 * Обходит каталог и строит записи корпуса (INV-D4/D5). Ограничен по глубине и
 * числу документов; неподдержанные/битые файлы пропускаются со счётчиком.
 * Ни один битый файл не роняет обход.
 */
export async function indexDir(opts: IndexDirOptions): Promise<IndexDirResult> {
  const baseDir = resolve(opts.baseDir);
  const start = resolve(baseDir, opts.dir);
  const maxDocs = Math.max(1, opts.maxDocuments ?? MAX_DOCUMENTS);
  const maxDepth = Math.max(0, opts.maxDepth ?? MAX_INDEX_DEPTH);
  const chunkOpts = { maxChunkChars: opts.maxChunkChars, maxChunksPerDoc: opts.maxChunksPerDoc };
  const entries: DocEntry[] = [];
  let skipped = 0;
  let truncated = false;

  const relOf = (abs: string): string => relative(baseDir, abs).split(sep).join("/");

  const handleFile = async (abs: string): Promise<void> => {
    try {
      const head = await readHead(abs);
      if (!opts.registry.resolve(abs, head)) {
        skipped += 1;
        return;
      }
      const ir = await opts.registry.parse(parseCtx(opts.logger), fileSource(baseDir, relOf(abs)));
      const st = await stat(abs);
      entries.push({
        path: abs,
        rel: relOf(abs),
        mtimeMs: st.mtimeMs,
        size: st.size,
        outline: ir.outline.map((n) => n.title),
        chunks: chunkIR(ir, chunkOpts),
      });
    } catch {
      skipped += 1;
    }
  };

  const walk = async (absDir: string, depth: number): Promise<void> => {
    if (entries.length >= maxDocs) {
      truncated = true;
      return;
    }
    let dirents: Awaited<ReturnType<typeof readdir>>;
    try {
      dirents = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirents) {
      if (entries.length >= maxDocs) {
        truncated = true;
        return;
      }
      const abs = join(absDir, d.name);
      if (d.isDirectory()) {
        if (SKIP_DIRS.has(d.name) || depth >= maxDepth) continue;
        await walk(abs, depth + 1);
      } else if (d.isFile()) {
        await handleFile(abs);
      }
    }
  };

  await walk(start, 0);
  return { entries, skipped, truncated };
}
