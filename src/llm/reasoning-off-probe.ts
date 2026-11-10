// Эмпирическая проба выключателя reasoning у хостед/openai-effort эндпоинтов.
//
// Декларативного признака «принимает reasoning_effort:"none"» ни LM Studio
// (с `allowed_options`), ни /models хостед-шлюзов не дают, а строгие
// OpenAI-совместимые серверы на неизвестный параметр отвечают 400 — поэтому
// единственный способ узнать off-switch, не рискуя рабочим запросом, —
// послать минимальный запрос с `none` и прочитать статус (спека
// docs/specs/2026-11-10-hosted-reasoning-off-discovery-design.md).
//
// Кэш: память + диск (`~/.mma/reasoning-off-cache.json`, оверрайд
// `MMA_REASONING_OFF_CACHE`), TTL как у reasoning-пробы (24ч/1ч).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { globalMmaDir } from "../config/paths";
import { readEnv } from "../config/env";
import {
  REASONING_CACHE_TTL_MS,
  REASONING_NEGATIVE_CACHE_TTL_MS,
} from "../config/timeouts";

/** Таймаут эмпирической пробы: это реальная генерация, но крошечная. */
export const REASONING_OFF_PROBE_TIMEOUT_MS = 15_000;

/** Сообщение пробы: короткое, ответ не важен — важен только HTTP-статус. */
const PROBE_MESSAGE = "Reply with exactly: ok";

interface CacheEntry {
  result: boolean;
  ts: string;
}

let memCache = new Map<string, { result: boolean; ts: number }>();

function cachePath(): string {
  return readEnv("REASONING_OFF_CACHE") ?? join(globalMmaDir(), "reasoning-off-cache.json");
}

function readDiskCache(): Record<string, CacheEntry> {
  try {
    const path = cachePath();
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, CacheEntry>;
  } catch {
    return {};
  }
}

function writeDiskCache(data: Record<string, CacheEntry>): void {
  try {
    const path = cachePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data), "utf-8");
  } catch {
    // Best-effort — сбой записи не должен ронять агента.
  }
}

function ttlFor(result: boolean): number {
  return result ? REASONING_CACHE_TTL_MS : REASONING_NEGATIVE_CACHE_TTL_MS;
}

function readCached(key: string): boolean | undefined {
  const mem = memCache.get(key);
  if (mem && Date.now() - mem.ts < ttlFor(mem.result)) return mem.result;
  const disk = readDiskCache()[key];
  if (disk) {
    const ts = new Date(disk.ts).getTime();
    const age = Date.now() - ts;
    if (Number.isFinite(ts) && age < ttlFor(disk.result)) {
      memCache.set(key, { result: disk.result, ts });
      return disk.result;
    }
  }
  return undefined;
}

function writeCached(key: string, result: boolean): void {
  memCache.set(key, { result, ts: Date.now() });
  const disk = readDiskCache();
  disk[key] = { result, ts: new Date().toISOString() };
  writeDiskCache(disk);
}

/** Тестовый шов: сбросить память и диск (диск изолируется через env). */
export function resetReasoningOffCache(): void {
  memCache = new Map();
  try {
    const path = cachePath();
    if (existsSync(path)) writeFileSync(path, "{}", "utf-8");
  } catch {
    /* best-effort */
  }
}

export interface ReasoningOffProbeOpts {
  apiKey?: string;
  /** Тип записи — для заголовка `x-opencode-session` (Zen/Go). */
  providerType?: string;
  timeoutMs?: number;
}

/**
 * Классификация 400/422: «строгий эндпоинт» — только когда отказ относится к
 * самому параметру (`reasoning`/`effort`) или к формулировке «unknown/unsupported
 * parameter». Иначе это несвязанная причина — живые случаи opencode-go: 400
 * «This Go model trains on request data» (ошибка заворачивается в
 * `invalid_request_error`, где есть слово «invalid») и 400 «MissingSessionID».
 * Ложный `false` запретил бы `"none"` на сутки.
 */
const PARAM_NAMED_RE = /(reasoning|effort)/i;
const PARAM_REJECT_RE =
  /(unrecognized|unsupported|unknown|invalid|unexpected|not supported|cannot be used)[^\n]{0,60}\b(param(?:eter)?s?|argument|field|key)\b|\b(param(?:eter)?s?|argument|field)\b[^\n]{0,60}(unsupported|not supported|unknown|invalid|unrecognized)/i;

function isStrictRejection(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) return false;
  return PARAM_NAMED_RE.test(body) || PARAM_REJECT_RE.test(body);
}

/**
 * Спрашивает эндпоинт, принимает ли он `reasoning_effort: "none"`.
 * @returns `true` — выключатель поддерживается; `false` — строгий (400/422
 *          именно про параметр); `null` — неизвестно (остальные статусы,
 *          сеть, таймаут), кэш не пишется.
 */
export async function probeReasoningOffSwitch(
  baseUrl: string,
  model: string,
  opts: ReasoningOffProbeOpts = {},
): Promise<boolean | null> {
  const timeoutMs = opts.timeoutMs ?? REASONING_OFF_PROBE_TIMEOUT_MS;
  const key = `${baseUrl}|${model}|openai-effort`;
  const cached = readCached(key);
  if (cached !== undefined) return cached;

  // baseUrl уже содержит /v1 — боевой путь `/chat/completions` строится от него
  // (как `openai-compat`), а не от origin: срез `/v1` давал 404 и «не знаем».
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.apiKey && opts.apiKey !== "not-needed") {
    headers.Authorization = `Bearer ${opts.apiKey}`;
  }
  // Зеркало боевого запроса: Zen/Go требуют session-заголовок для маршрутизации.
  if (opts.providerType === "opencode-zen" || opts.providerType === "opencode-go") {
    headers["x-opencode-session"] = `mma-off-probe-${process.pid}-${Date.now()}`;
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: PROBE_MESSAGE }],
        max_tokens: 8,
        reasoning_effort: "none",
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 200) {
      writeCached(key, true);
      return true;
    }
    const body = await response.text().catch(() => "");
    if (isStrictRejection(response.status, body)) {
      // Строгий эндпоинт: параметр отвергнут — `"none"` посылать нельзя.
      writeCached(key, false);
      return false;
    }
    return null;
  } catch {
    // Сеть/таймаут — «не смогли проверить», это не «выключателя нет» (INV-15).
    return null;
  }
}
