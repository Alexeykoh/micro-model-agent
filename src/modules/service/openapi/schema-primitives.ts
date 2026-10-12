// Примитивы и enum-наборы схем Agent Service API v1 (вынесено из `schemas.ts`,
// правило ≤300): конструкторы JSON Schema и закрытые списки контракта.
/** Произвольный JSON Schema-фрагмент (структуру не валидируем — это описание). */
export type JsonSchema = Record<string, unknown>;

/** Ссылка на схему из `components.schemas`. */
export function ref(name: string): JsonSchema {
  return { $ref: `#/components/schemas/${name}` };
}

export const string = (extra: JsonSchema = {}): JsonSchema => ({ type: "string", ...extra });
export const integer = (extra: JsonSchema = {}): JsonSchema => ({ type: "integer", ...extra });
export const boolean = (extra: JsonSchema = {}): JsonSchema => ({ type: "boolean", ...extra });

export const SESSION_STATUS = ["idle", "working", "queued", "failed", "archived"];
export const TASK_STATUS = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timeout",
  "waiting_input",
];

/** Стабильные `type`-URI ошибок v1 (`runtime/problem.ts`) — ветвиться по ним. */
export const PROBLEM_TYPES = [
  "https://mma.dev/errors/validation",
  "https://mma.dev/errors/idempotency-conflict",
  "https://mma.dev/errors/queue-full",
  "https://mma.dev/errors/rate-limited",
  "https://mma.dev/errors/no-session",
  "https://mma.dev/errors/no-task",
  "https://mma.dev/errors/tool-forbidden",
  "https://mma.dev/errors/output-invalid",
  "https://mma.dev/errors/provider-unavailable",
  "https://mma.dev/errors/timeout",
  "https://mma.dev/errors/internal",
];

/**
 * Типы событий SSE v1 (additive-only в рамках v1). Держится вручную, поэтому
 * guard-тест сверяет список с литералами в `emitEvent(...)`/`opts.emit(...)` по
 * исходникам `src/modules/service`.
 */
export const EVENT_TYPES = [
  "task.accepted",
  "task.started",
  "task.waiting_input",
  "task.finished",
  "task.failed",
  "task.cancelled",
  "text.delta",
  "reasoning.delta",
  "phase",
  "tool.start",
  "tool.end",
  "question",
  "plan",
];
