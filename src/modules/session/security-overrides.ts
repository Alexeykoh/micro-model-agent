// Нормализация security-оверрайдов сессии.
//
// Вынесено из `manager.ts`: это чистая функция над данными меты (аудит §7.15).
import type { SecurityConfig } from "../../config/types";
import type { SessionMeta } from "./types";

/**
 * Приводит сохранённые в мете оверрайды к форме `SecurityConfig`: недостающие
 * лимиты получают дефолты, отсутствие оверрайдов — `undefined`.
 */
export function normalizeSecurityOverrides(
  overrides?: SessionMeta["securityOverrides"],
): Partial<SecurityConfig> | undefined {
  if (!overrides) return undefined;

  return {
    maxFileOperations: overrides.maxFileOperations,
    maxRecursionDepth: overrides.maxRecursionDepth,
    rateLimits: overrides.rateLimits
      ? {
          maxRequestsPerMinute: overrides.rateLimits.maxRequestsPerMinute ?? 60,
          maxParallelTasks: overrides.rateLimits.maxParallelTasks ?? 5,
        }
      : undefined,
  };
}
