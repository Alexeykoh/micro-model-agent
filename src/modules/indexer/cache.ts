// Дисковый кэш индекса проекта: envelope с версией, root и сигнатурой дерева.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import type { IndexResult } from "./walker";

/**
 * Инкремент при смене envelope или формы `IndexResult`: кэши старого MMA
 * считаются протухшими и перестраиваются.
 */
/** Версия схемы кэша индекса. */
export const CACHE_VERSION = 2;

/** Дисковая обёртка с валидационными метаданными вокруг индекса. */
interface CacheEnvelope {
  version: number;
  /** Абсолютный корень проекта, для которого построен индекс. */
  root: string;
  /** Отпечаток дерева из `Indexer.scanSignature()` на момент сохранения. */
  signature: string;
  result: IndexResult;
}

/** Опции кэша индекса: корень проекта и функция сигнатуры дерева. */
export interface IndexCacheOptions {
  /** Абсолютный корень проекта; кэш под другой root отвергается. */
  root?: string;
  /**
   * Текущая сигнатура дерева проекта. Если задана, `load()` пересчитывает её и
   * отвергает кэш с другой сохранённой сигнатурой — протухшая карта проекта
   * никогда не попадёт в системный промпт. Опусти для отключения валидации.
   */
  signature?: () => string;
}

/** Дисковый кэш индекса с валидацией версии/root/сигнатуры. */
export class IndexCache {
  private cachePath: string;
  private cache: IndexResult | null = null;
  private root: string | undefined;
  private signature: (() => string) | undefined;

  constructor(cacheDir: string, opts: IndexCacheOptions = {}) {
    this.cachePath = join(cacheDir, "index-cache.json");
    this.root = opts.root;
    this.signature = opts.signature;
  }

  /**
   * Возвращает кэшированный индекс, только если он описывает текущее дерево.
   * Отвергает кэш при расхождении версии схемы, сохранённого `root` или
   * `signature`; легаси-кэш (сырой `IndexResult` без envelope) считается
   * протухшим. Вызывающие на `null` делают полный обход.
   */
  load(): IndexResult | null {
    if (this.cache) return this.cache;
    if (!existsSync(this.cachePath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.cachePath, "utf-8")) as Partial<CacheEnvelope>;
      if (parsed.version !== CACHE_VERSION || !parsed.result) return null;
      if (this.root !== undefined && parsed.root !== this.root) return null;
      if (this.signature && parsed.signature !== this.currentSignature()) return null;
      this.cache = parsed.result;
      return this.cache;
    } catch {
      return null;
    }
  }

  /** Сохраняет результат индекса в кэш (память + диск). */
  save(result: IndexResult): void {
    this.cache = result;
    const envelope: CacheEnvelope = {
      version: CACHE_VERSION,
      root: this.root ?? "",
      signature: this.currentSignature(),
      result,
    };
    const dir = join(this.cachePath, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
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

  /**
   * Считает сигнатуру дерева защищённо: нечитаемое дерево даёт пустую строку,
   * которая не совпадёт с сохранённой успешным обходом — битое дерево
   * инвалидирует кэш, а не вызывает доверие к нему.
   */
  private currentSignature(): string {
    if (!this.signature) return "";
    try {
      return this.signature();
    } catch {
      return "";
    }
  }
}
