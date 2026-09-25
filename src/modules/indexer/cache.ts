import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import type { IndexResult } from "./walker";

/**
 * Bump whenever the envelope or `IndexResult` shape changes so caches written
 * by an older MMA are treated as stale and rebuilt.
 */
export const CACHE_VERSION = 2;

/** On-disk wrapper carrying the validation metadata around the index. */
interface CacheEnvelope {
  version: number;
  /** Absolute project root the index was built for. */
  root: string;
  /** Tree fingerprint from `Indexer.scanSignature()` at save time. */
  signature: string;
  result: IndexResult;
}

export interface IndexCacheOptions {
  /** Absolute project root; a cache built for a different root is rejected. */
  root?: string;
  /**
   * Current project-tree signature. When provided, `load()` re-computes it and
   * rejects a cache whose stored signature differs, so a stale project map can
   * never reach the system prompt. Omit to disable signature validation.
   */
  signature?: () => string;
}

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
   * Return the cached index only when it still describes the current tree.
   * Rejects a cache when the schema `version`, stored `root` or tree
   * `signature` differ; a legacy cache (raw `IndexResult`, no envelope) is
   * treated as stale. Callers fall back to a full walk on `null`.
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

  invalidate(): void {
    this.cache = null;
    if (existsSync(this.cachePath)) {
      try {
        rmSync(this.cachePath);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Evaluate the tree signature defensively: an unreadable tree yields an
   * empty string, which can never match a signature stored by a successful
   * walk — so a broken tree invalidates the cache instead of trusting it.
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
