// src/modules/reasoning/probe.ts
import type { LLMProvider, Message } from "../../llm/provider";
import type { ReasoningStrategy } from "../../config/types";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

const PROBE_MESSAGES: Message[] = [
  { role: "user", content: "Reply with exactly: ok" },
];

/** Cache entry stored on disk. */
interface CacheEntry {
  result: boolean;
  /** ISO timestamp of when the probe ran. */
  ts: string;
}

/** TTL: re-probe after 24 hours. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Disk cache path: ~/.mma/reasoning-cache.json (override with MMA_REASONING_CACHE). */
function cachePath(): string {
  return process.env.MMA_REASONING_CACHE ?? join(homedir(), ".mma", "reasoning-cache.json");
}

/** In-memory L1 cache (same-process fast path). */
const memCache = new Map<string, { result: boolean; ts: number }>();

/**
 * Probe whether the backend actually respects the reasoning effort mechanism.
 * Sends a trivial non-streaming request with level forced to "none" via the
 * mapped strategy. If reasoning_content still appears, the mechanism is ignored.
 */
/**
 * Probe whether the backend actually respects the reasoning effort mechanism.
 * @returns `true` = mechanism respected, `false` = mechanism ignored,
 *          `null` = transient error (caller must NOT cache this).
 */
export async function probeReasoningSupport(
  provider: LLMProvider,
  strategy: ReasoningStrategy,
  signal?: AbortSignal,
): Promise<boolean | null> {
  if (strategy === "none") return false;

  try {
    let hasReasoning = false;
    for await (const chunk of provider.chat(PROBE_MESSAGES, undefined, signal, {
      maxTokens: 32,
      reasoningEffort: "none",
      reasoningStrategy: strategy,
    })) {
      if (chunk.type === "reasoning") hasReasoning = true;
    }
    // If reasoning content appeared despite "none", the mechanism is ignored
    return !hasReasoning;
  } catch {
    // Transient error (network/auth/stream) — do NOT report "not supported".
    // Returning null signals the caller to skip caching, so a one-off failure
    // does not disable the reasoning mechanism for the 24h TTL.
    return null;
  }
}

export function cacheKey(baseUrl: string, model: string): string {
  return `${baseUrl}|${model}`;
}

/**
 * Read cached probe result. Checks in-memory first, then disk.
 * Returns `undefined` if cache miss or stale (>24h).
 */
export function getCachedProbeResult(key: string): boolean | undefined {
  // L1: in-memory
  const mem = memCache.get(key);
  if (mem && Date.now() - mem.ts < CACHE_TTL_MS) {
    return mem.result;
  }

  // L2: disk
  const disk = readDiskCache();
  const entry = disk[key];
  if (entry) {
    const age = Date.now() - new Date(entry.ts).getTime();
    if (age < CACHE_TTL_MS) {
      memCache.set(key, { result: entry.result, ts: Date.now() });
      return entry.result;
    }
  }

  return undefined;
}

/**
 * Store probe result in both in-memory and disk cache.
 */
export function setCachedProbeResult(key: string, result: boolean): void {
  const now = new Date().toISOString();
  memCache.set(key, { result, ts: Date.now() });

  const disk = readDiskCache();
  disk[key] = { result, ts: now };
  writeDiskCache(disk);
}

export function resetProbeCache(): void {
  memCache.clear();
  const path = cachePath();
  if (existsSync(path)) {
    writeFileSync(path, "{}", "utf-8");
  }
}

function readDiskCache(): Record<string, CacheEntry> {
  try {
    const path = cachePath();
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf-8"));
    }
  } catch {
    // Corrupted cache — start fresh
  }
  return {};
}

function writeDiskCache(data: Record<string, CacheEntry>): void {
  try {
    const path = cachePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
  } catch {
    // Best-effort — disk write failure must not crash the agent
  }
}
