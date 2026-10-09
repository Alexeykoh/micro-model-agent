/**
 * `components.schemas` Agent Service API v1 (OpenAPI 3.1, dialect JSON Schema).
 *
 * Схемы — вручную, из тех же TS-типов, что сериализуются в ответы
 * (`../types.ts`, `../runtime/task-registry.ts`, `../runtime/problem.ts`).
 * Guard-тест сверяет ключевые поля схем с типами, поэтому расхождение
 * (новое поле в `JobObject`, забытое в спеке) ломает тест, а не интегратора.
 */

/** Произвольный JSON Schema-фрагмент (структуру не валидируем — это описание). */
export type JsonSchema = Record<string, unknown>;

/** Ссылка на схему из `components.schemas`. */
export function ref(name: string): JsonSchema {
  return { $ref: `#/components/schemas/${name}` };
}

const string = (extra: JsonSchema = {}): JsonSchema => ({ type: "string", ...extra });
const integer = (extra: JsonSchema = {}): JsonSchema => ({ type: "integer", ...extra });
const boolean = (extra: JsonSchema = {}): JsonSchema => ({ type: "boolean", ...extra });

const SESSION_STATUS = ["idle", "working", "queued", "failed", "archived"];
const TASK_STATUS = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timeout",
  "waiting_input",
];

/** Стабильные `type`-URI ошибок v1 (`runtime/problem.ts`) — ветвиться по ним. */
const PROBLEM_TYPES = [
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

/** Типы событий SSE v1 (additive-only в рамках v1). */
const EVENT_TYPES = [
  "task.accepted",
  "task.started",
  "task.finished",
  "task.failed",
  "task.cancelled",
  "task.waiting_input",
  "text.delta",
  "reasoning.delta",
  "phase",
  "tool.start",
  "tool.end",
  "question",
  "plan",
  "error",
];

/** Все схемы контракта: ключ = имя в `components.schemas`. */
export const SCHEMAS: Record<string, JsonSchema> = {
  ProblemDetails: {
    type: "object",
    description:
      "RFC 9457 Problem Details. Клиент ветвится по стабильному `type`, а не по `detail`.",
    required: ["type", "title", "status"],
    properties: {
      type: { type: "string", enum: PROBLEM_TYPES },
      title: string(),
      status: integer(),
      detail: string({ description: "Человекочитаемая деталь; не для ветвления в коде." }),
      instance: string(),
      is_retriable: boolean({ description: "MMA-расширение: повторять ли запрос." }),
      retry_after_ms: integer({ description: "MMA-расширение: подсказка задержки, мс." }),
      trace_id: string(),
      suggestions: { type: "array", items: string() },
    },
  },

  SessionSummary: {
    type: "object",
    required: ["id", "name", "status", "model", "contextWindow", "messageCount", "createdAt", "updatedAt"],
    properties: {
      id: string({ description: "Внутренний id сессии (`ses_…`)." }),
      externalRef: string({ description: "Ключ интегратора (`chat_id`, `doc_id`, …), если задан." }),
      name: string(),
      status: { type: "string", enum: SESSION_STATUS },
      model: string(),
      contextWindow: integer(),
      messageCount: integer(),
      createdAt: string({ format: "date-time" }),
      updatedAt: string({ format: "date-time" }),
    },
  },

  SessionCreateRequest: {
    type: "object",
    properties: {
      name: string({ description: "Отображаемое имя; при пустом генерируется автоматически." }),
      externalRef: string({ description: "Ваш ключ сессии для последующей привязки задач." }),
    },
  },

  SessionList: {
    type: "object",
    required: ["sessions"],
    properties: { sessions: { type: "array", items: ref("SessionSummary") } },
  },

  OutputSpec: {
    type: "object",
    description:
      "Контракт структурированного вывода. Поддерживается strict-подмножество JSON Schema: " +
      "`type`, `required`, `properties`, `items`, `enum`, `additionalProperties: false`.",
    required: ["format"],
    properties: {
      format: { type: "string", enum: ["text", "json"] },
      schema: { type: "object", description: "JSON Schema (strict-подмножество)." },
    },
  },

  TaskSubmitRequest: {
    type: "object",
    required: ["input"],
    properties: {
      input: string({ description: "Текст задачи для агента." }),
      mode: {
        type: "string",
        enum: ["interactive", "job"],
        default: "job",
        description:
          "`job` — автономная (вопросы запрещены, работает `toolAllowlist`); " +
          "`interactive` — вопросы через SSE + `/answer`.",
      },
      output: ref("OutputSpec"),
      toolAllowlist: {
        type: "array",
        items: string(),
        description:
          "Только для `mode: job`. Строгий allowlist: теги и `alwaysOn` его НЕ обходят. " +
          "Вызов интерактивного или неразрешённого тула → `failed` с `…/tool-forbidden`.",
      },
      timeoutMs: integer({ description: "Таймаут хода; по умолчанию — лимит рантайма." }),
      callbackUrl: {
        type: "string",
        format: "uri",
        description: "Webhook на терминальное событие (тело — Job-объект, подпись HMAC).",
      },
      externalRef: string({ description: "Метка интегратора для задачи (пишется в журнал сессии)." }),
      wait: {
        type: "boolean",
        default: false,
        description: "Ждать терминальный статус до `service.syncWaitMs` (иначе `202`).",
      },
    },
  },

  TaskAnswerRequest: {
    type: "object",
    required: ["id"],
    description: "Ответ на вопрос интерактивной задачи (`question`-событие).",
    properties: {
      id: string({ description: "Id вопроса из SSE-события `question`." }),
      answer: {
        description: "Выбранный вариант (строка) или произвольный текст ответа.",
      },
    },
  },

  TaskResult: {
    type: "object",
    required: ["text"],
    properties: {
      text: string({ description: "Финальный ответ агента." }),
      data: { description: "Разобранный JSON, если запрошен `output.format: json`." },
    },
  },

  TaskUsage: {
    type: "object",
    required: ["promptTokens", "completionTokens", "costUsd"],
    properties: {
      promptTokens: integer(),
      completionTokens: integer(),
      costUsd: { type: "number" },
    },
  },

  JobObject: {
    type: "object",
    description:
      "Единый объект задачи: ответ `GET /v1/tasks/{jobId}`, тело webhook-колбэка и " +
      "терминальный ответ сабмита при `wait: true`.",
    required: ["jobId", "sessionId", "status", "mode", "createdAt"],
    properties: {
      jobId: string(),
      sessionId: string(),
      status: { type: "string", enum: TASK_STATUS },
      mode: { type: "string", enum: ["interactive", "job"] },
      progress: {
        type: "object",
        properties: { percent: integer(), message: string() },
      },
      result: ref("TaskResult"),
      usage: ref("TaskUsage"),
      error: ref("ProblemDetails"),
      createdAt: string({ format: "date-time" }),
      startedAt: string({ format: "date-time" }),
      finishedAt: string({ format: "date-time" }),
    },
  },

  TaskAccepted: {
    type: "object",
    description: "Ответ `202 Accepted`: задача принята, статус — по `statusUrl`.",
    required: ["jobId", "status", "statusUrl"],
    properties: {
      jobId: string(),
      status: { type: "string", enum: TASK_STATUS },
      statusUrl: string(),
    },
  },

  TaskAck: {
    type: "object",
    description: "Краткий подтверждающий ответ (`cancel` / `answer`).",
    required: ["jobId", "status"],
    properties: {
      jobId: string(),
      status: { type: "string", enum: TASK_STATUS },
    },
  },

  EventEnvelope: {
    type: "object",
    description: "Тело SSE-события (`data:`); `seq` монотонный на сессию.",
    required: ["v", "seq", "ts", "type", "sessionId", "data"],
    properties: {
      v: { type: "integer", const: 1 },
      seq: integer(),
      ts: integer({ description: "Epoch-мс." }),
      type: { type: "string", enum: EVENT_TYPES },
      sessionId: string(),
      taskId: string(),
      data: { description: "Полезная нагрузка, форма зависит от `type`." },
    },
  },

  HealthResponse: {
    type: "object",
    required: ["status", "version"],
    properties: {
      status: { type: "string", const: "ok" },
      version: string({ description: "Версия рантайма MMA." }),
    },
  },

  ReadyResponse: {
    type: "object",
    required: ["status"],
    properties: {
      status: { type: "string", const: "ready" },
    },
  },

  HtmlPage: {
    type: "string",
    description: "Самодостаточная HTML-страница контракта (`text/html`), без внешних ресурсов.",
  },

  OpenApiDocument: {
    type: "object",
    description: "Эта спецификация (сама описывает себя — `/v1/openapi.json`).",
    required: ["openapi", "info", "paths"],
    properties: {
      openapi: { type: "string", const: "3.1.0" },
      info: { type: "object" },
      paths: { type: "object" },
    },
  },
};
