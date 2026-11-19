// Типы операций и общие параметры/ответы Agent Service API v1 — вынесено из
// `operations.ts` (правило ≤300).
import type { JsonSchema } from "./schemas";

/** HTTP-методы, используемые в контракте v1. */
export type SpecMethod = "get" | "post" | "delete";

/** Параметр операции (path/query/header). */
export interface SpecParameter {
  name: string;
  in: "path" | "query" | "header";
  description: string;
  required?: boolean;
  schema: JsonSchema;
}

/** Тело запроса. */
export interface SpecRequestBody {
  description: string;
  required?: boolean;
  schema: JsonSchema;
}

/** Один ответ операции. */
export interface SpecResponse {
  description: string;
  schema?: string;
  /** Media type ответа; по умолчанию `application/json`. */
  contentType?: string;
  /** Заголовки ответа: имя → описание (для клиентов, которые их читают). */
  headers?: Record<string, string>;
}

/** Операция контракта. */
export interface SpecOperation {
  method: SpecMethod;
  path: string;
  operationId: string;
  /** Группа для спеки (`tags`) и для секций человеческой страницы. */
  tag: string;
  summary: string;
  description?: string;
  /** `true` — маршрут открыт без bearer-токена (probes + discovery). */
  open?: boolean;
  params?: SpecParameter[];
  requestBody?: SpecRequestBody;
  responses: Record<string, SpecResponse>;
}

/** Ответ-ссылка на схему из `components.schemas`. */
export function ok(description: string, schema?: string): SpecResponse {
  return schema ? { description, schema } : { description };
}

/** Общая ошибочная ветка (RFC 9457) для защищённых операций. */
export const PROBLEM_RESPONSES = {
  "401": ok("Unauthorized — нет/неверен `Authorization: Bearer`"),
  default: ok("Problem Details (RFC 9457)", "ProblemDetails"),
};

/** Тело не влезло в кап (1 МиБ) — тело отвергается, сервер продолжает жить. */
export const TOO_LARGE: SpecResponse = ok("Тело запроса больше 1 МиБ", "ProblemDetails");

export const SESSION_ID = {
  name: "sessionId",
  in: "path",
  required: true,
  description: "Id сессии (`ses_…`)",
  schema: { type: "string" },
} as const;

export const JOB_ID = {
  name: "jobId",
  in: "path",
  required: true,
  description: "Id задачи (`job_…`)",
  schema: { type: "string" },
} as const;

/** Заголовки tenant-контекста control plane (`spec §10.2/§11`). */
export const TENANT_HEADERS: SpecParameter[] = [
  { name: "X-Mma-Tenant", in: "header", description: "Id тенанта (аудит/изоляция)", schema: { type: "string" } },
  { name: "X-Mma-Principal", in: "header", description: "Id вызывающего (по умолчанию `anon`)", schema: { type: "string" } },
  { name: "X-Mma-Run", in: "header", description: "Id прогона во внешней системе", schema: { type: "string" } },
  { name: "X-Mma-Tier", in: "header", description: "Тариф/уровень интегратора", schema: { type: "string" } },
  { name: "X-Mma-Scopes", in: "header", description: "Scopes через запятую", schema: { type: "string" } },
];

export const IDEMPOTENCY_HEADER: SpecParameter = {
  name: "Idempotency-Key",
  in: "header",
  description: "Ключ идемпотентности сабмита (TTL `service.idempotencyTtlHours`)",
  schema: { type: "string" },
};
