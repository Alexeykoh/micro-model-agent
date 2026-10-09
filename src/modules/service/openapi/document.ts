/**
 * Сборка OpenAPI 3.1 документа Agent Service API v1 из `operations.ts` +
 * `schemas.ts`. Чистая функция: тот же вход — тот же JSON, тестируется без
 * поднятия сервера.
 *
 * Намеренно не тянем generator: контракт маленький и стабильный, а ручная
 * таблица операций остаётся читаемым источником для человека (её же рендерит
 * `/v1/docs`). Расхождение спеки с реальными маршрутами ловит guard-тест.
 */
import { OPERATIONS, type SpecMethod, type SpecOperation } from "./operations";
import { ref, SCHEMAS } from "./schemas";

/** Версия спецификации (3.1 = dialect JSON Schema 2020-12, как в Swagger UI 5). */
export const OPENAPI_VERSION = "3.1.0";

/** Теги в порядке появления — он же порядок секций в спеке и на `/v1/docs`. */
const TAGS: Array<{ name: string; description: string }> = [
  {
    name: "ops",
    description: "Пробы, спецификация и человеческая страница контракта.",
  },
  {
    name: "sessions",
    description:
      "Сессии — постоянные диалоги. Авторитетная карта тенант→сессия живёт в control plane интегратора.",
  },
  {
    name: "tasks",
    description:
      "Задача (job) — один ход агента над сессией. `job` — автономная, `interactive` — с вопросами через SSE.",
  },
  {
    name: "events",
    description:
      "SSE-поток событий сессии. Оптимизация наблюдаемости: pull (`GET /v1/tasks/{jobId}`) — источник правды.",
  },
];

const DESCRIPTION = [
  "HTTP-контракт для внешних систем (боты, бэкенды, cron): те же агент, сессии и тулы,",
  "что в CLI/REPL/`mma web`, но стабильное версионированное API (база `/v1`).",
  "",
  "**Изоляция:** единица изоляции — процесс (1 тенант = 1 процесс со своим `MMA_CONFIG_DIR`",
  "и workspace), а не тенант внутри рантайма.",
  "",
  "**Auth:** если задан `service.token` (обязателен для non-loopback bind), все `/v1/*`,",
  "кроме проб и discovery, требуют `Authorization: Bearer <token>`. Tenant-контекст",
  "(`X-Mma-*`) резолвится только из заголовков и пишется в `session.jsonl`.",
  "",
  "**Ошибки:** RFC 9457 Problem Details; ветвиться по стабильному `type`-URI, не по `detail`.",
].join("\n");

/** Конвертирует операцию в объект OpenAPI Operation. */
function toOperation(op: SpecOperation, authRequired: boolean): Record<string, unknown> {
  const operation: Record<string, unknown> = {
    operationId: op.operationId,
    tags: [op.tag],
    summary: op.summary,
    ...(op.description ? { description: op.description } : {}),
    ...(op.params?.length ? { parameters: op.params } : {}),
    ...(op.requestBody
      ? {
          requestBody: {
            description: op.requestBody.description,
            required: op.requestBody.required ?? false,
            content: { "application/json": { schema: op.requestBody.schema } },
          },
        }
      : {}),
    responses: Object.fromEntries(
      Object.entries(op.responses).map(([status, r]) => [
        status,
        {
          description: r.description,
          ...(r.schema
            ? {
                content: {
                  [r.contentType ?? "application/json"]: { schema: ref(r.schema) },
                },
              }
            : {}),
        },
      ]),
    ),
  };
  // Явный `security: []` снимает корневой bearer с открытых маршрутов.
  if (op.open && authRequired) operation.security = [];
  return operation;
}

/** Группирует плоский список операций по пути (требование формата OpenAPI). */
function groupByPath(ops: SpecOperation[], authRequired: boolean): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of ops) {
    const item = (paths[op.path] ??= {});
    item[op.method] = toOperation(op, authRequired);
  }
  return paths;
}

/** Вход сборки спецификации. */
export interface OpenApiOptions {
  /** Версия рантайма (`readMmaVersion()`) — попадает в `info.version`. */
  version: string;
  /** `true`, если сервис требует bearer-токен (тогда discovery-маршруты явные). */
  authRequired: boolean;
}

/**
 * Собирает OpenAPI 3.1 документ v1. Возвращает свежий объект на каждый вызов:
 * мутация результата не влияет на следующую сборку и на тесты.
 */
export function buildOpenApiDocument({ version, authRequired }: OpenApiOptions): Record<string, unknown> {
  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: "MMA Agent Service API",
      version: `1.0.0+mma-${version}`,
      summary: "Agent Service API v1 — HTTP-контракт `mma serve` для внешних систем.",
      description: DESCRIPTION,
      license: { name: "MIT", identifier: "MIT" },
    },
    // Расширение спецификации в корне (Specification Extensions, OpenAPI 3.1):
    // факты о прогоне, из которых собран документ, — по ним видно, что перед
    // читателем (в т.ч. требуется ли bearer).
    "x-runtime": {
      mmaVersion: version,
      authRequired,
      isolation: "one process per tenant",
      docsPage: "/v1/docs",
      specsSource: "src/modules/service/openapi/operations.ts",
    },
    servers: [{ url: "/", description: "Текущий рантайм (`mma serve`)" }],
    tags: TAGS,
    paths: groupByPath(OPERATIONS, authRequired),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Внутренний токен control plane (`service.token` / `MMA_SERVICE_TOKEN`).",
        },
      },
      schemas: SCHEMAS,
    },
    security: authRequired ? [{ bearerAuth: [] }] : [],
  };
}

/** HTTP-методы в документе — для guard-теста «спека покрывает реальные маршруты». */
export const SPEC_METHODS: SpecMethod[] = ["get", "post", "delete"];
