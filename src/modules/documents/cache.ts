/**
 * Дисковый кэш корпуса документов (INV-D4/D5). По образцу
 * `src/modules/indexer/cache.ts`, но **изолирован** от индексатора кода: свой
 * файл (`documents-cache.json`), свой envelope и своя валидация. Чужой/битый/
 * старого формата кэш **игнорируется**, а не доверяется.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DocChunk } from "./chunks";

/** Версия схемы кэша: инкремент делает старые кэши протухшими. */
export const CACHE_VERSION = 1;

/** Имя файла кэша корпуса рядом с `index-cache.json`. */
export const CACHE_FILE = "documents-cache.json";

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
