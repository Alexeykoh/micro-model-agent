/**
 * Запись провайдеров (split W11): add/update/delete на `AppConfig`.
 *
 * Чистые операции без I/O — их делят локальный веб и демон (host wire), чтобы
 * валидация имён и легаси-зеркалирование не разъехались.
 */
import type { AppConfig, ProviderEntry } from "../config/types";
import { DEFAULTS } from "../config/defaults";
import { providerEntryName, providerNameTaken } from "../modules/providers/naming";
import type { ProviderInput } from "./providers-input";

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
 * (`provider.type`/`baseUrl` без `entries`) должен пережить первый add — иначе
 * новая запись молча его заменит.
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
    // Вырожденный случай: virgin-легаси без `entries` сидирует ровно одну
    // запись, и create-POST с её именем — in-place upsert мигрированного
    // конфига, а не коллизия с другим провайдером.
    const loneSeeded =
      fromLegacySeed && entries.length === 1 && providerEntryName(entries[0]) === name;
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

  const entry: ProviderEntry =
    idx >= 0 ? { ...entries[idx] } : { type: input.type, baseUrl: input.baseUrl };
  entry.type = input.type;
  entry.baseUrl = input.baseUrl;
  if (input.label !== undefined) entry.label = input.label;
  if (input.apiKey !== undefined) entry.apiKey = input.apiKey;
  if (input.contextWindow !== undefined) entry.contextWindow = input.contextWindow;
  if (input.priority !== undefined) entry.priority = input.priority;
  if (input.maxCompletionTokens !== undefined) entry.maxCompletionTokens = input.maxCompletionTokens;
  if (input.cache !== undefined) entry.cache = { ...(entry.cache ?? {}), ...input.cache };
  if (input.unlistedModels !== undefined) {
    entry.unlistedModels = input.unlistedModels.length ? input.unlistedModels : undefined;
  }
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
