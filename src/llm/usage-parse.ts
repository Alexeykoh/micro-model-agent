/** Нормализация `usage` из ответа/чанка провайдера в поля `Chunk.usage`. */
import type { CacheReportFormat } from "../config/types";
import { parseCacheUsage, type CacheUsage } from "./cache-usage";
import { parseReportedCost } from "./reported-cost";

/** Токены и стоимость одного вызова в терминах контракта `Chunk`. */
export interface ParsedChunkUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cache?: CacheUsage;
  costUsd?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Собирает usage из полезной нагрузки провайдера. Стоимость ищется и вне
 * `usage` (`opencode.list_cost`) — поэтому на вход идёт весь payload.
 */
export function parseChunkUsage(
  payload: unknown,
  format: CacheReportFormat,
): ParsedChunkUsage | undefined {
  if (!isRecord(payload) || !isRecord(payload.usage)) return undefined;
  const usage = payload.usage;
  const costUsd = parseReportedCost(payload);
  return {
    promptTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
    completionTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
    totalTokens: typeof usage.total_tokens === "number" ? usage.total_tokens : 0,
    cache: parseCacheUsage(usage, format),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}
