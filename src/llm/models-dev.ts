/**
 * models.dev-фолбэк для хостед-шлюзов (OpenCode Zen/Go), чей собственный
 * `/models` отдаёт голые id без метаданных контекста (проверено вживую:
 * только `{id, object, created, owned_by}`).
 *
 * models.dev — открытая база моделей (MIT, sst/models.dev), её же использует
 * сам opencode. Каталог `api.json`: `Record<providerId, { models:
 * Record<modelId, { limit: { context } }> }>`, провайдер `opencode` держит
 * модели под теми же bare id, что отдаёт Zen (`deepseek-v4.1-flash` →
 * `limit.context`).
 *
 * На диске только slim-проекция (`opencode` → id → контекст):
 * `~/.mma/models-dev-cache.json` (override `MMA_MODELS_DEV_CACHE`), TTL 24h
 * как у reasoning-пробника. Любой сбой — null, вызывающий хранит настроенный
 * `contextWindow` (fail-open).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { globalMmaDir } from "../config/paths";

const MODELS_DEV_URL = "https://models.dev/api.json";

/** TTL: перечитывать каталог после 24 часов. */
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

/** Slim-проекция на диске (никогда не весь каталог). */
interface ModelsDevCache {
  ts: string;
  /** id модели → окно контекста провайдера `opencode`. */
  models: Record<string, number>;
}

/** Опции лукапа: таймаут запроса каталога. */
export interface ModelsDevOpts {
  timeoutMs?: number;
}

function cachePath(): string {
  return process.env.MMA_MODELS_DEV_CACHE ?? join(globalMmaDir(), "models-dev-cache.json");
}

/** In-memory L1: свежая проекция на время жизни процесса. */
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
    // Битый кэш — перечитываем ниже.
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
    // Best-effort — падение записи не должно ронять агента.
  }
}

/** `limit.context` одной записи модели, если это годное число. */
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
 * Ищет `model` в секции провайдера `opencode` каталога models.dev.
 * Только точное совпадение id (Zen отдаёт bare id, каталог ключует так же).
 * Возвращает каталожный `limit.context`, на любом промахе — null.
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
    // Офлайн с протухшим кэшем: протухшее окно лучше никакого.
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

/** Тестовый шов: сбросить in-memory проекцию (диск изолирован через env). */
export function resetModelsDevCache(): void {
  memCache = null;
}
