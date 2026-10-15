// Проба поддержки reasoning: проверяет, уважает ли бэкенд механизм effort, кэш на 24ч.
import type { LLMProvider, Message } from "../../llm/provider";
import type { ReasoningLevel, ReasoningStrategy } from "../../config/types";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { globalMmaDir } from "../../config/paths";
import { readEnv } from "../../config/env";
import { REASONING_CACHE_TTL_MS as CACHE_TTL_MS } from "../../config/timeouts";

const PROBE_MESSAGES: Message[] = [
  { role: "user", content: "Reply with exactly: ok" },
];

/** Запись дискового кэша. */
interface CacheEntry {
  result: boolean;
  /** ISO-метка времени прогона пробы. */
  ts: string;
}

/** Путь дискового кэша: ~/.mma/reasoning-cache.json (переопределяется MMA_REASONING_CACHE). */
function cachePath(): string {
  return readEnv("REASONING_CACHE") ?? join(globalMmaDir(), "reasoning-cache.json");
}

/** In-memory L1-кэш (быстрый путь в пределах процесса). */
const memCache = new Map<string, { result: boolean; ts: number }>();

/**
 * Проверяет, уважает ли бэкенд механизм reasoning effort, ДВУМЯ независимыми
 * ординалами (D2): при «выключено» reasoning-чанков быть не должно, при
 * «высоко» — должны появиться. Расхождение = «не подтверждено»: либо off не
 * соблюдён, либо механизм инертен («выключено» неотличимо от «модель молчит»).
 * @returns `true` — подтверждено, `false` — не подтверждено,
 *          `null` — транзиентная ошибка (вызывающий НЕ должен кэшировать).
 */
export async function probeReasoningSupport(
  provider: LLMProvider,
  strategy: ReasoningStrategy,
  reasoningOff = false,
  signal?: AbortSignal,
): Promise<boolean | null> {
  if (strategy === "none") return false;
  // Выключение нечем ВЫРАЗИТЬ (strict-OpenAI без объявленного off): измерять
  // нечего — считаем механизм поддерживаемым, effort уровням он не вредит.
  if (strategy === "openai-effort" && !reasoningOff) return true;

  try {
    const off = await countReasoningChars(provider, "none", signal);
    const on = await countReasoningChars(provider, "high", signal);
    return off === 0 && on > 0;
  } catch {
    // Транзиентная ошибка (сеть/авторизация/стрим) — НЕ сообщаем "не поддерживается".
    // Возврат null запрещает вызывающему кэшировать, чтобы разовый сбой
    // не отключал reasoning-механизм на весь 24ч TTL.
    return null;
  }
}

/**
 * Считает символы reasoning-контента на заданном уровне. Через провайдера —
 * значит механизм выражения выбирает он сам (INV-R1), проба его не знает.
 */
async function countReasoningChars(
  provider: LLMProvider,
  level: ReasoningLevel,
  signal?: AbortSignal,
): Promise<number> {
  let chars = 0;
  for await (const chunk of provider.chat(PROBE_MESSAGES, undefined, signal, {
    maxTokens: 512,
    reasoningEffort: level,
  })) {
    if (chunk.type === "reasoning") chars += chunk.content?.length ?? 1;
  }
  return chars;
}

/** Ключ кэша пробы: baseUrl + модель. */
export function cacheKey(baseUrl: string, model: string): string {
  return `${baseUrl}|${model}`;
}

/**
 * Читает кэшированный результат пробы. Сначала память, потом диск.
 * Возвращает `undefined` при промахе или протухании (>24ч).
 */
export function getCachedProbeResult(key: string): boolean | undefined {
  // L1: память
  const mem = memCache.get(key);
  if (mem && Date.now() - mem.ts < CACHE_TTL_MS) {
    return mem.result;
  }

  // L2: диск
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
 * Кладет результат пробы в память и на диск.
 */
export function setCachedProbeResult(key: string, result: boolean): void {
  const now = new Date().toISOString();
  memCache.set(key, { result, ts: Date.now() });

  const disk = readDiskCache();
  disk[key] = { result, ts: now };
  writeDiskCache(disk);
}

/** Сбрасывает кэш пробы (память + дисковый файл). */
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
    // Битый кэш — начинаем с чистого
  }
  return {};
}

function writeDiskCache(data: Record<string, CacheEntry>): void {
  try {
    const path = cachePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
  } catch {
    // Best-effort: сбой записи на диск не должен ронять агента
  }
}
