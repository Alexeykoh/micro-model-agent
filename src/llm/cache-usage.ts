/** Парсинг кеш-статистики из usage-ответов провайдеров. */
import type { CacheReportFormat } from "../config/types";

/**
 * Нормализованная статистика кеша из ответа провайдера.
 * `uncachedTokens` — prompt-токены, обработанные заново (не из кеша); именно
 * они, вместе с `cachedTokens`, участвуют в расчёте стоимости.
 */
export interface CacheUsage {
  /** Прочитано из кеша (cache read). */
  cachedTokens: number;
  /** Записано в кеш (cache write) — на части провайдеров платно. */
  cacheWriteTokens: number;
  /** Prompt-токены не из кеша. */
  uncachedTokens: number;
  /** `api` — цифры от провайдера; `derived` — вычислено клиентом. */
  source: "api" | "derived";
}

/** Безопасно приводит значение к конечному числу; иначе undefined. */
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Объект ли это (для защиты от null/строк в ответе). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Разбирает usage-объект провайдера в нормализованный `CacheUsage` согласно
 * формату отчёта. Возвращает undefined, когда провайдер не сообщает о кеше —
 * вызывающий не должен выдавать отсутствие данных за «cache miss».
 *
 * `estimatedPromptTokens` нужен только для формата `ollama`, который не
 * отдаёт cache-полей: кешированное вычисляется как разница оценки и
 * `prompt_eval_count`.
 */
export function parseCacheUsage(
  usage: unknown,
  format: CacheReportFormat,
  estimatedPromptTokens?: number,
): CacheUsage | undefined {
  if (!isRecord(usage)) return undefined;

  switch (format) {
    case "openai": {
      const details = usage.prompt_tokens_details;
      // OpenCode Go дублирует кеш в `opencode.tokens.cache_read` даже когда
      // `prompt_tokens_details` отсутствует.
      const opencodeTokens = isRecord(usage.opencode) ? usage.opencode.tokens : undefined;
      const cached = isRecord(details)
        ? num(details.cached_tokens)
        : isRecord(opencodeTokens)
          ? num(opencodeTokens.cache_read)
          : undefined;
      if (cached === undefined) return undefined;
      const prompt = num(usage.prompt_tokens) ?? cached;
      const write = isRecord(details) ? (num(details.cache_write_tokens) ?? 0) : 0;
      return {
        cachedTokens: cached,
        cacheWriteTokens: write,
        uncachedTokens: Math.max(0, prompt - cached),
        source: "api",
      };
    }

    case "deepseek": {
      const hit = num(usage.prompt_cache_hit_tokens);
      const miss = num(usage.prompt_cache_miss_tokens);
      if (hit === undefined && miss === undefined) return undefined;
      return {
        cachedTokens: hit ?? 0,
        cacheWriteTokens: 0,
        uncachedTokens: miss ?? 0,
        source: "api",
      };
    }

    case "anthropic": {
      const read = num(usage.cache_read_input_tokens);
      const creation = num(usage.cache_creation_input_tokens);
      if (read === undefined && creation === undefined) return undefined;
      return {
        cachedTokens: read ?? 0,
        cacheWriteTokens: creation ?? 0,
        uncachedTokens: num(usage.input_tokens) ?? 0,
        source: "api",
      };
    }

    case "ollama": {
      const evaluated = num(usage.prompt_eval_count);
      if (evaluated === undefined || estimatedPromptTokens === undefined) return undefined;
      return {
        cachedTokens: Math.max(0, estimatedPromptTokens - evaluated),
        cacheWriteTokens: 0,
        uncachedTokens: evaluated,
        source: "derived",
      };
    }

    default:
      return undefined;
  }
}
