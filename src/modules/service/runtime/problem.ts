/**
 * RFC 9457 Problem Details для Agent Service API v1.
 *
 * Клиент ветвится по стабильному `type`-URI, а не по тексту `detail` (спека §9.3).
 * `is_retriable`/`retry_after_ms`/`trace_id`/`suggestions` — расширения MMA поверх RFC.
 */

/** Стабильные `type`-URI v1. Удаление/переименование — вне v1 (additive-only). */
export const PROBLEM_TYPES = {
  validation: "https://mma.dev/errors/validation",
  idempotencyConflict: "https://mma.dev/errors/idempotency-conflict",
  queueFull: "https://mma.dev/errors/queue-full",
  rateLimited: "https://mma.dev/errors/rate-limited",
  noSession: "https://mma.dev/errors/no-session",
  noTask: "https://mma.dev/errors/no-task",
  tenantMismatch: "https://mma.dev/errors/tenant-mismatch",
  toolForbidden: "https://mma.dev/errors/tool-forbidden",
  outputInvalid: "https://mma.dev/errors/output-invalid",
  providerUnavailable: "https://mma.dev/errors/provider-unavailable",
  timeout: "https://mma.dev/errors/timeout",
  internal: "https://mma.dev/errors/internal",
} as const;

/** Ключ стабильного типа ошибки. */
export type ProblemType = keyof typeof PROBLEM_TYPES;

/** Problem Details объект (RFC 9457 + расширения). */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  is_retriable?: boolean;
  retry_after_ms?: number;
  trace_id?: string;
  suggestions?: string[];
}

/** Собирает Problem Details, подставляя `type`-URI по короткому ключу. */
export function problem(p: {
  type: ProblemType;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  retriable?: boolean;
  retryAfterMs?: number;
  traceId?: string;
  suggestions?: string[];
}): ProblemDetails {
  return {
    type: PROBLEM_TYPES[p.type],
    title: p.title,
    status: p.status,
    ...(p.detail ? { detail: p.detail } : {}),
    ...(p.instance ? { instance: p.instance } : {}),
    is_retriable: p.retriable ?? false,
    retry_after_ms: p.retryAfterMs ?? 0,
    ...(p.traceId ? { trace_id: p.traceId } : {}),
    ...(p.suggestions ? { suggestions: p.suggestions } : {}),
  };
}
