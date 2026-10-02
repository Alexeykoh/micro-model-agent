// REST-хендлеры страницы «Модель и провайдер»: add/update/delete записей, хот-свап агента.
// Вынесены из `settings-api.ts`. Секреты не эхом (`hasApiKey` вместо ключа).
// Auth и same-origin — выше в `server.ts`.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig, CacheCapability, ProviderEntry } from "../../../config/types";
import { DEFAULTS } from "../../../config/defaults";
import { providerEntryName, providerNameTaken } from "../../providers/naming";
import { readBodyError, sendJson } from "../util";
import { readJsonBody } from "../http/body";
import { persistAndReconfigure } from "../http/persist";
import { buildProviderViews } from "./providers-view";
import type { WebUiState } from "../state";

/** `GET /api/providers` — отредактированные записи + имя активного. */
export function handleProvidersGet(res: ServerResponse, s: WebUiState): void {
  if (!s.config) {
    sendJson(res, 503, { error: "config_unavailable" });
    return;
  }
  sendJson(res, 200, buildProviderViews(s.config));
}

/** Вход add/update: обязательны тип и URL, остальное опционально. */
interface ProviderInput {
  type: string;
  label?: string;
  baseUrl: string;
  apiKey?: string;
  contextWindow?: number;
  priority?: number;
  rpm?: number;
  parallel?: number;
  maxCompletionTokens?: number;
  cache?: Partial<CacheCapability>;
  retry?: { maxRetries?: number; baseDelay?: number; maxDelay?: number };
  /** Текущее имя правимой записи; при создании отсутствует. */
  originalName?: string;
}

function optionalInt(rec: Record<string, unknown>, key: string, min: number): number | null | undefined {
  return optionalIntRange(rec, key, min, Number.MAX_SAFE_INTEGER);
}

function optionalIntRange(
  rec: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | null | undefined {
  const v = rec[key];
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

const CACHE_MECHANISMS = ["auto", "explicit", "local", "none"];
const CACHE_REPORTS = ["openai", "deepseek", "anthropic", "ollama", "none"];
const CACHE_FLAGS = [
  "sessionHeader",
  "requestCachePrompt",
  "requestPromptCacheKey",
  "requestSessionId",
  "requestCacheControl",
  "requestStreamUsage",
] as const;

function coerceFlag(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === 0 || v === 1) return v === 1;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "1") return true;
    if (s === "false" || s === "0") return false;
  }
  return null;
}

/** Парсит потуловой объект оверрайда `cache`. `null` — мусор (400). */
function parseCache(v: unknown): Partial<CacheCapability> | null | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) return null;
  const rec = v as Record<string, unknown>;
  const out: Partial<CacheCapability> = {};
  if (rec.mechanism !== undefined) {
    if (typeof rec.mechanism !== "string" || !CACHE_MECHANISMS.includes(rec.mechanism)) return null;
    out.mechanism = rec.mechanism as CacheCapability["mechanism"];
  }
  if (rec.report !== undefined) {
    if (typeof rec.report !== "string" || !CACHE_REPORTS.includes(rec.report)) return null;
    out.report = rec.report as CacheCapability["report"];
  }
  for (const flag of CACHE_FLAGS) {
    const fv = rec[flag];
    if (fv === undefined) continue;
    const b = coerceFlag(fv);
    if (b === null) return null;
    out[flag] = b;
  }
  return out;
}

/** Парсит потуловой объект оверрайда `retry`. `null` — мусор (400). */
function parseRetry(
  v: unknown,
): { maxRetries?: number; baseDelay?: number; maxDelay?: number } | null | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) return null;
  const rec = v as Record<string, unknown>;
  const specs = [
    ["maxRetries", 0, 10],
    ["baseDelay", 0, 60000],
    ["maxDelay", 0, 300000],
  ] as const;
  const out: { maxRetries?: number; baseDelay?: number; maxDelay?: number } = {};
  for (const [key, min, max] of specs) {
    const n = optionalIntRange(rec, key, min, max);
    if (n === null) return null;
    if (n !== undefined) out[key] = n;
  }
  return out;
}

/** Парсит и валидирует тело POST. `null` — реджект с 400. */
function parseProviderInput(rec: Record<string, unknown>): ProviderInput | null {
  const type = typeof rec.type === "string" ? rec.type.trim() : "";
  const baseUrl = typeof rec.baseUrl === "string" ? rec.baseUrl.trim() : "";
  if (!type || !baseUrl) return null;
  if (rec.apiKey !== undefined && rec.apiKey !== null && typeof rec.apiKey !== "string") return null;
  if (rec.label !== undefined && rec.label !== null && typeof rec.label !== "string") return null;
  if (rec.originalName !== undefined && rec.originalName !== null && typeof rec.originalName !== "string") {
    return null;
  }

  const contextWindow = optionalInt(rec, "contextWindow", 1024);
  const priority = optionalInt(rec, "priority", 0);
  const rpm = optionalInt(rec, "rpm", 1);
  const parallel = optionalInt(rec, "parallel", 1);
  if (contextWindow === null || priority === null || rpm === null || parallel === null) return null;

  const maxCompletionTokens = optionalIntRange(rec, "maxCompletionTokens", 512, 128000);
  if (maxCompletionTokens === null) return null;
  const cache = parseCache(rec.cache);
  if (cache === null) return null;
  const retry = parseRetry(rec.retry);
  if (retry === null) return null;

  const input: ProviderInput = { type, baseUrl };
  if (typeof rec.label === "string" && rec.label.trim()) input.label = rec.label.trim();
  if (typeof rec.originalName === "string" && rec.originalName.trim()) {
    input.originalName = rec.originalName.trim();
  }
  if (typeof rec.apiKey === "string" && rec.apiKey.trim()) input.apiKey = rec.apiKey.trim();
  if (contextWindow !== undefined) input.contextWindow = contextWindow;
  if (priority !== undefined) input.priority = priority;
  if (rpm !== undefined) input.rpm = rpm;
  if (parallel !== undefined) input.parallel = parallel;
  if (maxCompletionTokens !== undefined) input.maxCompletionTokens = maxCompletionTokens;
  if (cache !== undefined) input.cache = cache;
  if (retry !== undefined) input.retry = retry;
  return input;
}

/** Зеркалит активную запись на легаси-плоские поля `provider`. */
function mirrorLegacy(config: AppConfig, entry: ProviderEntry): void {
  config.provider.type = entry.type;
  config.provider.baseUrl = entry.baseUrl;
  if (entry.apiKey !== undefined) config.provider.apiKey = entry.apiKey;
  if (entry.maxCompletionTokens !== undefined) {
    config.provider.maxCompletionTokens = entry.maxCompletionTokens;
  }
}

/**
 * Существующие записи с подсевом легаси-однопровайдерного конфига. Легаси
 * (`provider.type`/`baseUrl` без `entries`) должен пережить первый add —
 * иначе новая запись молча его заменит.
 */
function seededEntries(config: AppConfig): ProviderEntry[] {
  const provider = config.provider;
  const entries = Array.isArray(provider.entries) ? [...provider.entries] : [];
  if (entries.length === 0 && provider.type) {
    entries.push({
      type: provider.type,
      label: provider.active || provider.type,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
    });
  }
  return entries;
}

/** Итог upsert: записанное имя или конфликт имени. */
export type UpsertProviderResult =
  | { ok: true; name: string }
  | { ok: false; error: "name-conflict" };

/**
 * Создаёт запись провайдера или обновляет названную в `input.originalName`.
 * POST без `originalName` всегда создаёт. Имя, бьющееся с чужим label/type, —
 * отказ. Возвращает имя записанной записи.
 */
export function upsertProvider(config: AppConfig, input: ProviderInput): UpsertProviderResult {
  const provider = config.provider;
  const fromLegacySeed = !Array.isArray(provider.entries) || provider.entries.length === 0;
  const entries = seededEntries(config);
  const name = input.label || input.type;
  if (providerNameTaken(entries, name, input.originalName)) {
    // Вырожденный случай: virgin-легаси без `entries` сидирует ровно одну запись,
    // и create-POST с её именем — in-place upsert мигрированного конфига,
    // а не коллизия с другим провайдером.
    const loneSeeded = fromLegacySeed && entries.length === 1 && providerEntryName(entries[0]) === name;
    if (!loneSeeded || input.originalName) {
      return { ok: false, error: "name-conflict" };
    }
  }
  let idx = input.originalName
    ? entries.findIndex(
        (e) => providerEntryName(e) === input.originalName || e.type === input.originalName,
      )
    : -1;
  if (idx < 0 && fromLegacySeed && entries.length === 1 && providerEntryName(entries[0]) === name) {
    idx = 0;
  }

  const entry: ProviderEntry = idx >= 0 ? { ...entries[idx] } : { type: input.type, baseUrl: input.baseUrl };
  entry.type = input.type;
  entry.baseUrl = input.baseUrl;
  if (input.label !== undefined) entry.label = input.label;
  if (input.apiKey !== undefined) entry.apiKey = input.apiKey;
  if (input.contextWindow !== undefined) entry.contextWindow = input.contextWindow;
  if (input.priority !== undefined) entry.priority = input.priority;
  if (input.maxCompletionTokens !== undefined) entry.maxCompletionTokens = input.maxCompletionTokens;
  if (input.cache !== undefined) entry.cache = { ...(entry.cache ?? {}), ...input.cache };
  if (input.retry !== undefined) {
    const prev: { maxRetries?: number; baseDelay?: number; maxDelay?: number } = entry.retry ?? {};
    entry.retry = {
      maxRetries: input.retry.maxRetries ?? prev.maxRetries ?? DEFAULTS.retry.maxRetries,
      baseDelay: input.retry.baseDelay ?? prev.baseDelay ?? DEFAULTS.retry.baseDelay,
      maxDelay: input.retry.maxDelay ?? prev.maxDelay ?? DEFAULTS.retry.maxDelay,
    };
  }
  if (input.rpm !== undefined || input.parallel !== undefined) {
    const prev = entry.rateLimits ?? { maxRequestsPerMinute: 60, maxParallelTasks: 1 };
    entry.rateLimits = {
      maxRequestsPerMinute: input.rpm ?? prev.maxRequestsPerMinute,
      maxParallelTasks: input.parallel ?? prev.maxParallelTasks,
    };
  }

  if (idx >= 0) entries[idx] = entry;
  else entries.push(entry);
  config.provider.entries = entries;

  // Активный провайдер сохраняем; активным становится только первый в истории.
  const wasActive = provider.active || provider.type;
  if (!provider.active) config.provider.active = providerEntryName(entries[0]);
  if (providerEntryName(entry) === wasActive || entries.length === 1) mirrorLegacy(config, entry);
  return { ok: true, name: providerEntryName(entry) };
}

/** `POST /api/providers` — add/update, персист, reconfigure. */
export function handleProvidersPost(req: IncomingMessage, res: ServerResponse, s: WebUiState): void {
  if (!s.config) {
    sendJson(res, 503, { error: "config_unavailable" });
    return;
  }
  const config = s.config;
  readJsonBody(req, s.maxBodyBytes)
    .then(async (rec) => {
      if (!rec) {
        sendJson(res, 400, { ok: false, error: "invalid JSON" });
        return;
      }
      const input = parseProviderInput(rec);
      if (!input) {
        sendJson(res, 400, { ok: false, error: "invalid-provider" });
        return;
      }
      const result = upsertProvider(config, input);
      if (!result.ok) {
        sendJson(res, 409, { ok: false, error: "name-conflict" });
        return;
      }
      const persisted = await persistAndReconfigure(s, config);
      sendJson(res, 200, { ok: true, name: result.name, ...buildProviderViews(config), ...persisted });
    })
    .catch((err: unknown) => {
      readBodyError(req, res, err);
    });
}

/**
 * Удаляет запись провайдера. Активный удалять отказывается (сначала
 * переключись), чтобы агент не потерял живой бэкенд.
 */
export function removeProvider(config: AppConfig, name: string): "ok" | "active" | "missing" {
  const provider = config.provider;
  if (name === (provider.active || provider.type)) return "active";
  const entries = Array.isArray(provider.entries) ? provider.entries : [];
  const idx = entries.findIndex((e) => (e.label || e.type) === name || e.type === name);
  if (idx < 0) return "missing";
  config.provider.entries = entries.filter((_, i) => i !== idx);
  return "ok";
}

/** `DELETE /api/providers/:name` — удалить, персист, reconfigure. */
export function handleProvidersDelete(res: ServerResponse, name: string, s: WebUiState): void {
  if (!s.config) {
    sendJson(res, 503, { error: "config_unavailable" });
    return;
  }
  if (!name) {
    sendJson(res, 400, { ok: false, error: "invalid-name" });
    return;
  }
  const config = s.config;
  const outcome = removeProvider(config, name);
  if (outcome === "active") {
    sendJson(res, 409, { ok: false, error: "active-provider" });
    return;
  }
  if (outcome === "missing") {
    sendJson(res, 404, { ok: false, error: "not_found" });
    return;
  }
  void persistAndReconfigure(s, config).then(
    (result) => {
      sendJson(res, 200, { ok: true, ...buildProviderViews(config), ...result });
    },
    () => {
      sendJson(res, 500, { ok: false, error: "delete_failed" });
    },
  );
}

/** Диспатч `/api/providers*`; возвращает, обработан ли запрос. */
export function handleProvidersApi(
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  s: WebUiState,
): boolean {
  const p = reqUrl.pathname;
  if (p === "/api/providers" && req.method === "GET") {
    handleProvidersGet(res, s);
    return true;
  }
  if (p === "/api/providers" && req.method === "POST") {
    handleProvidersPost(req, res, s);
    return true;
  }
  if (p.startsWith("/api/providers/") && req.method === "DELETE") {
    handleProvidersDelete(res, decodeURIComponent(p.slice("/api/providers/".length)), s);
    return true;
  }
  return false;
}
