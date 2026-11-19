/**
 * Дисковый кэш declarative-возможностей активной пары эндпоинт+модель.
 *
 * Локальный прокси (llama-swap) держит несколько моделей на одном порту и
 * отвечает 409 на `/props?model=…&autoload=false`, пока модель холодная.
 * Без кэша старт после перезапуска теряет объявленные сервером уровни
 * reasoning и выключатель none, хотя бэкенд их поддерживает. Кэш хранит только
 * то, что сервер РЕАЛЬНО объявил раньше, с TTL; выдуманных уровней он не
 * создаёт (INV-R7).
 */
import type { ModelCapabilities } from "../../config/types";
import { globalMmaDir } from "../../config/paths";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

/** Возраст записи, после которого доверие к ней заканчивается. */
const TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
  capabilities: ModelCapabilities;
  ts: string;
}

function cachePath(): string {
  return join(globalMmaDir(), "capabilities-cache.json");
}

function entryKey(baseUrl: string, model: string): string {
  return `${baseUrl}|${model}`;
}

function readAll(): Record<string, CacheEntry> {
  try {
    const path = cachePath();
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf-8")) as Record<string, CacheEntry>;
  } catch {
    // Битый кэш — начинаем с чистого.
  }
  return {};
}

/** Последний успешный native-probe пары, если он не протух. */
export function readCachedCapabilities(
  baseUrl: string,
  model: string,
): ModelCapabilities | undefined {
  const entry = readAll()[entryKey(baseUrl, model)];
  if (!entry?.capabilities || typeof entry.ts !== "string") return undefined;
  const ts = new Date(entry.ts).getTime();
  if (!Number.isFinite(ts) || Date.now() - ts >= TTL_MS) return undefined;
  return entry.capabilities;
}

/** Сохраняет только реально объявленные бэкендом capabilities. */
export function writeCachedCapabilities(
  baseUrl: string,
  model: string,
  capabilities: ModelCapabilities,
): void {
  const all = readAll();
  all[entryKey(baseUrl, model)] = { capabilities, ts: new Date().toISOString() };
  try {
    const path = cachePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(all, null, 2), "utf-8");
  } catch {
    // Best-effort: кэш не должен ломать запуск.
  }
}
