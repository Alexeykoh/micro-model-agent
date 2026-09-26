/**
 * models.dev fallback for hosted gateways (OpenCode Zen/Go) whose own
 * `/models` endpoint returns bare ids with no context metadata (verified
 * live: `{id, object, created, owned_by}` only).
 *
 * models.dev is an open-source model database (MIT, sst/models.dev) that
 * opencode itself uses internally. Its `api.json` catalog is keyed
 * `Record<providerId, { models: Record<modelId, { limit: { context } }> }>`
 * and the `opencode` provider lists models under the same bare ids Zen
 * serves (`deepseek-v4.1-flash` → `limit.context`).
 *
 * Only a slim projection (`opencode` → model id → context) is kept on disk:
 * `~/.mma/models-dev-cache.json` (override with `MMA_MODELS_DEV_CACHE`),
 * 24h TTL like the reasoning-probe cache. Every failure mode returns null —
 * the caller keeps the configured `contextWindow` (fail-open).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { globalMmaDir } from "../config/paths";

const MODELS_DEV_URL = "https://models.dev/api.json";

/** TTL: re-fetch the catalog after 24 hours. */
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

/** Slim projection stored on disk (never the whole catalog). */
interface ModelsDevCache {
  ts: string;
  /** model id → context window for the `opencode` provider. */
  models: Record<string, number>;
}

export interface ModelsDevOpts {
  timeoutMs?: number;
}

function cachePath(): string {
  return process.env.MMA_MODELS_DEV_CACHE ?? join(globalMmaDir(), "models-dev-cache.json");
}

/** In-memory L1: fresh projection for the process lifetime. */
let memCache: { models: Record<string, number>; ts: number } | null = null;

function readDiskCache(): ModelsDevCache | null {
  try {
    const path = cachePath();
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<ModelsDevCache>;
    if (typeof parsed.ts !== "string" || !parsed.models || typeof parsed.models !== "object") {
      return null;
    }
    return { ts: parsed.ts, models: parsed.models as Record<string, number> };
  } catch {
    // Corrupted cache — refetch below.
    return null;
  }
}

function writeDiskCache(models: Record<string, number>): void {
  try {
    const path = cachePath();
    mkdirSync(dirname(path), { recursive: true });
    const entry: ModelsDevCache = { ts: new Date().toISOString(), models };
    writeFileSync(path, JSON.stringify(entry), "utf-8");
  } catch {
    // Best-effort — disk write failure must not crash the agent.
  }
}

/** Catalog `limit.context` of one model entry, if it is a usable number. */
function modelContextOf(meta: unknown): number | null {
  const context = (meta as { limit?: { context?: unknown } } | null)?.limit?.context;
  if (typeof context !== "number" || !Number.isFinite(context) || context <= 0) return null;
  return Math.floor(context);
}

function extractOpencodeModels(catalog: unknown): Record<string, number> | null {
  if (!catalog || typeof catalog !== "object") return null;
  const provider = (catalog as Record<string, unknown>).opencode;
  if (!provider || typeof provider !== "object") return null;
  const models = (provider as Record<string, unknown>).models;
  if (!models || typeof models !== "object") return null;
  const out: Record<string, number> = {};
  for (const [id, meta] of Object.entries(models as Record<string, unknown>)) {
    const context = modelContextOf(meta);
    if (context !== null) out[id] = context;
  }
  return out;
}

async function fetchCatalog(timeoutMs: number): Promise<Record<string, number> | null> {
  try {
    const response = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    return extractOpencodeModels((await response.json()) as unknown);
  } catch {
    return null;
  }
}

/**
 * Look up `model` in the `opencode` provider section of the models.dev
 * catalog. Exact id match only (Zen serves bare ids, the catalog keys them
 * identically). Returns the catalog `limit.context`, or null on any miss.
 */
export async function lookupModelsDevContext(
  model: string,
  opts: ModelsDevOpts = {},
): Promise<number | null> {
  const timeoutMs = opts.timeoutMs ?? 10000;
  if (memCache && Date.now() - memCache.ts < CATALOG_TTL_MS) {
    return memCache.models[model] ?? null;
  }
  const disk = readDiskCache();
  if (disk && Date.now() - new Date(disk.ts).getTime() < CATALOG_TTL_MS) {
    memCache = { models: disk.models, ts: Date.now() };
    return disk.models[model] ?? null;
  }
  const fresh = await fetchCatalog(timeoutMs);
  if (!fresh) {
    // Offline with a stale cache: a stale window beats no window.
    if (disk) {
      memCache = { models: disk.models, ts: Date.now() };
      return disk.models[model] ?? null;
    }
    return null;
  }
  memCache = { models: fresh, ts: Date.now() };
  writeDiskCache(fresh);
  return fresh[model] ?? null;
}

/** Test seam: drop the in-memory projection (disk cache is env-isolated). */
export function resetModelsDevCache(): void {
  memCache = null;
}
