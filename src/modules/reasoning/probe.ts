// Проба поддержки reasoning: проверяет, уважает ли бэкенд механизм effort,
// кэш привязан к механизму (стратегия+off-switch); плюс — 24ч, минус — 1ч.
import type { LLMProvider, Message } from "../../llm/provider";
import type { ReasoningLevel, ReasoningStrategy } from "../../config/types";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { globalMmaDir } from "../../config/paths";
import { readEnv } from "../../config/env";
import {
  REASONING_CACHE_TTL_MS as CACHE_TTL_MS,
  REASONING_NEGATIVE_CACHE_TTL_MS as NEGATIVE_CACHE_TTL_MS,
} from "../../config/timeouts";

/**
 * Промпт пробы «включено». Тривиальный `Reply with exactly: ok` не провоцирует
 * рассуждение: модель вправе ответить сразу, и проба ложно решает, что
 * механизм инертен (INV-R6). Многошаговый вопрос делает появление
 * reasoning-чанков ожидаемым у thinking-модели.
 */
const PROBE_MESSAGES: Message[] = [
  {
    role: "user",
    content:
      "Compute 17 * 23 step by step. Show your reasoning, then reply with exactly: ok",
  },
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

/** Механизм, с которым реально работал агент для пары baseUrl|model (INV-R8). */
export interface RememberedReasoningMechanism {
  strategy: ReasoningStrategy;
  reasoningOff: boolean;
}

const mechanismCache = new Map<string, RememberedReasoningMechanism>();

function mechanismKey(baseUrl: string, model: string): string {
  return `${baseUrl}|${model}`;
}

/** Запоминает резолвнутый механизм — UI читает его вместо угадывания по пресету. */
export function rememberReasoningMechanism(
  baseUrl: string,
  model: string,
  mechanism: RememberedReasoningMechanism,
): void {
  mechanismCache.set(mechanismKey(baseUrl, model), mechanism);
}

/** Механизм, резолвнутый агентом в этом процессе, либо `undefined`. */
export function getRememberedReasoningMechanism(
  baseUrl: string,
  model: string,
): RememberedReasoningMechanism | undefined {
  return mechanismCache.get(mechanismKey(baseUrl, model));
}

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

/**
 * Ключ кэша пробы: эндпоинт + модель + механизм. Стратегия и наличие
 * off-switch — часть механизма (INV-R6): вердикт, снятый для `prompt-tag`,
 * недействителен для `openai-effort`, даже если пара baseUrl|model та же.
 */
export function cacheKey(
  baseUrl: string,
  model: string,
  strategy: ReasoningStrategy = "none",
  reasoningOff = false,
): string {
  return `${baseUrl}|${model}|${strategy}|${reasoningOff ? "off" : "nooff"}`;
}

/**
 * Читает кэшированный результат пробы. Сначала память, потом диск.
 * Возвращает `undefined` при промахе или протухании: положительный вердикт
 * живёт 24 ч, отрицательный — час (INV-R6).
 */
export function getCachedProbeResult(key: string): boolean | undefined {
  // L1: память
  const mem = memCache.get(key);
  if (mem && Date.now() - mem.ts < ttlFor(mem.result)) {
    return mem.result;
  }

  // L2: диск
  const disk = readDiskCache();
  const entry = disk[key];
  if (entry) {
    // TTL считаем от реальной метки, а не от момента чтения: иначе повторный
    // старт продлевал бы устаревший вердикт.
    const ts = new Date(entry.ts).getTime();
    const age = Date.now() - ts;
    if (Number.isFinite(ts) && age < ttlFor(entry.result)) {
      memCache.set(key, { result: entry.result, ts });
      return entry.result;
    }
  }

  return undefined;
}

/** TTL записи: отрицательный вердикт — короткий (INV-R6). */
export function probeCacheTtlMs(result: boolean): number {
  return result ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS;
}

function ttlFor(result: boolean): number {
  return probeCacheTtlMs(result);
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
  mechanismCache.clear();
  const path = cachePath();
  if (existsSync(path)) {
    writeFileSync(path, "{}", "utf-8");
  }
}

/**
 * Полный путь пробы для активной пары: запоминает механизм, читает кэш по
 * ключу механизма, при промахе пробует и кэширует только определённый итог.
 * Единственная точка, где `baseUrl|model` встречается с `strategy|off`, —
 * поэтому ключ не может разъехаться между агентом и UI.
 * @returns `true` подтверждено, `false` не подтверждено, `null` транзиентка.
 */
export async function probeReasoningSupportCached(
  provider: LLMProvider,
  strategy: ReasoningStrategy,
  reasoningOff: boolean,
  baseUrl: string,
  model: string,
  signal?: AbortSignal,
): Promise<boolean | null> {
  rememberReasoningMechanism(baseUrl, model, { strategy, reasoningOff });
  const key = cacheKey(baseUrl, model, strategy, reasoningOff);
  const cached = getCachedProbeResult(key);
  if (cached !== undefined) return cached;
  const passed = await probeReasoningSupport(provider, strategy, reasoningOff, signal);
  if (passed !== null) setCachedProbeResult(key, passed);
  return passed;
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
