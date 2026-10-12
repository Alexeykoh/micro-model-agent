/**
 * Операции Agent Service API v1 — единственный источник правды для машинной
 * спеки (`GET /v1/openapi.json`), человеческой страницы (`GET /v1/docs`) и
 * guard-теста, который не даст маршруту появиться без описания.
 *
 * Схемы берутся из `schemas.ts`, тексты — из того же контракта, что
 * `docs/agents/service-api.md`; при расхождении правьте здесь и в доках.
 */
import { ref } from "./schemas";
import {
  ok,
  PROBLEM_RESPONSES,
  TOO_LARGE,
  SESSION_ID,
  JOB_ID,
  TENANT_HEADERS,
  IDEMPOTENCY_HEADER,
  type SpecOperation,
} from "./operation-types";

// Типы/общие параметры живут в `./operation-types`; реэкспорт для импортёров.
export * from "./operation-types";

/** Все операции v1 в порядке «сначала discovery, потом sessions, потом tasks». */
export const OPERATIONS: SpecOperation[] = [
  // ── Discovery / ops ─────────────────────────────────────────────────────
  {
    method: "get",
    path: "/v1/health",
    operationId: "getHealth",
    tag: "ops",
    summary: "Liveness: процесс жив",
    description:
      "Без auth. Не проверяет провайдера — только факт, что рантайм отвечает.",
    open: true,
    responses: { "200": ok("Процесс жив", "HealthResponse") },
  },
  {
    method: "get",
    path: "/v1/ready",
    operationId: "getReady",
    tag: "ops",
    summary: "Readiness: конфиг загружен, провайдер отвечает",
    description: "Без auth. `503 provider-unavailable` (ретраится), если провайдер недоступен.",
    open: true,
    responses: {
      "200": ok("Провайдер доступен", "ReadyResponse"),
      "503": ok("Провайдер недоступен", "ProblemDetails"),
    },
  },
  {
    method: "get",
    path: "/v1/openapi.json",
    operationId: "getOpenApiDocument",
    tag: "ops",
    summary: "Машинная спецификация контракта (OpenAPI 3.1)",
    description:
      "Без auth: это описание публичного API, а не данные тенанта. Скормите файл " +
      "Swagger UI / Redoc / Postman / Insomnia или сгенерируйте клиент.",
    open: true,
    responses: { "200": ok("OpenAPI 3.1 документ", "OpenApiDocument") },
  },
  {
    method: "get",
    path: "/v1/docs",
    operationId: "getApiDocs",
    tag: "ops",
    summary: "Человеческая шпаргалка по контракту",
    description:
      "Без auth. Та же выжимка, что и спека, но читаемая: quickstart cURL, таблица " +
      "эндпоинтов, SSE-события, коды ошибок. Для машин — `/v1/openapi.json`.",
    open: true,
    responses: {
      "200": {
        description: "Самодостаточная HTML-страница (без внешних ресурсов)",
        schema: "HtmlPage",
        contentType: "text/html",
      },
    },
  },

  // ── Sessions ────────────────────────────────────────────────────────────
  {
    method: "post",
    path: "/v1/sessions",
    operationId: "createSession",
    tag: "sessions",
    summary: "Создать сессию",
    description:
      "Сессия — постоянный диалог. `externalRef` — ваш ключ (`chat_id`, `doc_id`); " +
      "авторитетная карта тенант→сессия живёт в вашем control plane.",
    requestBody: { description: "Необязательные имя и внешний ключ", schema: ref("SessionCreateRequest") },
    responses: {
      "201": ok("Сессия создана", "SessionSummary"),
      "413": TOO_LARGE,
      ...PROBLEM_RESPONSES,
    },
  },
  {
    method: "get",
    path: "/v1/sessions",
    operationId: "listSessions",
    tag: "sessions",
    summary: "Список сессий",
    params: [
      { name: "externalRef", in: "query", description: "Фильтр по вашему ключу", schema: { type: "string" } },
      {
        name: "status",
        in: "query",
        description: "Фильтр по статусу",
        schema: { type: "string", enum: ["idle", "working", "queued", "failed", "archived"] },
      },
    ],
    responses: { "200": ok("Список сессий", "SessionList"), ...PROBLEM_RESPONSES },
  },
  {
    method: "get",
    path: "/v1/sessions/{sessionId}",
    operationId: "getSession",
    tag: "sessions",
    summary: "Метаданные и статус сессии",
    params: [SESSION_ID],
    responses: {
      "200": ok("Метаданные сессии", "SessionSummary"),
      "404": ok("Сессия не найдена", "ProblemDetails"),
      ...PROBLEM_RESPONSES,
    },
  },
  {
    method: "delete",
    path: "/v1/sessions/{sessionId}",
    operationId: "deleteSession",
    tag: "sessions",
    summary: "Удалить сессию",
    description: "Занятая (работающая/в очереди) сессия → `409`: сначала отмените задачи.",
    params: [SESSION_ID],
    responses: {
      "204": ok("Удалена"),
      "404": ok("Сессия не найдена", "ProblemDetails"),
      "409": ok("Сессия занята", "ProblemDetails"),
      ...PROBLEM_RESPONSES,
    },
  },

  // ── Tasks ───────────────────────────────────────────────────────────────
  {
    method: "post",
    path: "/v1/sessions/{sessionId}/tasks",
    operationId: "submitTask",
    tag: "tasks",
    summary: "Сабмит задачи (ход над сессией)",
    description:
      "202 + `Location`/`Retry-After`, либо 200 с терминальным Job-объектом при `wait: true` " +
      "(уклалось в `service.syncWaitMs`). Повтор с тем же `Idempotency-Key` и тем же телом → " +
      "тот же `jobId`; с другим телом → `409`. Pull (`GET /v1/tasks/{jobId}`) — источник правды.",
    params: [SESSION_ID, IDEMPOTENCY_HEADER, ...TENANT_HEADERS],
    requestBody: {
      description: "Параметры задачи",
      required: true,
      schema: ref("TaskSubmitRequest"),
    },
    responses: {
      "200": ok("Терминальный Job-объект (`wait: true` уложился в бюджет)", "JobObject"),
      "202": {
        description: "Задача принята; статус — по `statusUrl`",
        schema: "TaskAccepted",
        headers: {
          Location: "URL статуса задачи (`statusUrl` тела)",
          "Retry-After": "Подсказка, через сколько секунд опросить статус",
        },
      },
      "400": ok("Пустой `input` или неверный тип поля", "ProblemDetails"),
      "404": ok("Сессия не найдена", "ProblemDetails"),
      "409": ok("Idempotency-Key с другим телом", "ProblemDetails"),
      "413": TOO_LARGE,
      "422": ok("Некорректный `output.schema` (вне поддерживаемого подмножества)", "ProblemDetails"),
      "429": ok("Очередь сессии полна", "ProblemDetails"),
      ...PROBLEM_RESPONSES,
    },
  },
  {
    method: "get",
    path: "/v1/tasks/{jobId}",
    operationId: "getTask",
    tag: "tasks",
    summary: "Статус и результат задачи",
    description: "Тот же Job-объект, что и в webhook-колбэке. Источник правды по задаче.",
    params: [JOB_ID],
    responses: {
      "200": ok("Job-объект", "JobObject"),
      "404": ok("Задача не найдена", "ProblemDetails"),
      ...PROBLEM_RESPONSES,
    },
  },
  {
    method: "post",
    path: "/v1/tasks/{jobId}/cancel",
    operationId: "cancelTask",
    tag: "tasks",
    summary: "Кооперативная отмена задачи",
    description:
      "Останавливает ход (`Agent.shutdown`), сбрасывает висящие вопросы, шлёт webhook. " +
      "Терминальная задача → 200 с её текущим статусом (идемпотентно).",
    params: [JOB_ID],
    responses: {
      "200": ok("Задача уже была терминальной", "TaskAck"),
      "202": ok("Отмена принята", "TaskAck"),
      "404": ok("Задача не найдена", "ProblemDetails"),
      ...PROBLEM_RESPONSES,
    },
  },
  {
    method: "post",
    path: "/v1/tasks/{jobId}/answer",
    operationId: "answerTask",
    tag: "tasks",
    summary: "Ответ на вопрос интерактивной задачи",
    description:
      "Только для `mode: interactive` в статусе `waiting_input`. Id вопроса берётся из " +
      "SSE-события `question`. Закрытие SSE-потока на такой задаче отменяет её.",
    params: [JOB_ID],
    requestBody: {
      description: "Id вопроса и выбранный ответ (или произвольный текст)",
      required: true,
      schema: ref("TaskAnswerRequest"),
    },
    responses: {
      "202": ok("Ответ принят, задача снова `running`", "TaskAck"),
      "400": ok("Не указан `id` вопроса", "ProblemDetails"),
      "404": ok("Задача или вопрос не найдены", "ProblemDetails"),
      "409": ok("Задача не ждёт ввода", "ProblemDetails"),
      "413": TOO_LARGE,
      ...PROBLEM_RESPONSES,
    },
  },

  // ── Events ──────────────────────────────────────────────────────────────
  {
    method: "get",
    path: "/v1/sessions/{sessionId}/events",
    operationId: "streamEvents",
    tag: "events",
    summary: "SSE-поток событий сессии",
    description:
      "`id:` = `seq` (монотонный на сессию), `data:` = EventEnvelope. Resume: заголовок " +
      "`Last-Event-ID` или `?since=<seq>` из in-memory буфера (между рестартами процесса — " +
      "best-effort; статус всегда доступен pull'ом). Keep-alive — комментарии `: ping` " +
      "каждые 20 с. Закрытие потока отменяет ТОЛЬКО интерактивную задачу; `job` продолжается.",
    params: [
      SESSION_ID,
      { name: "since", in: "query", description: "Переиграть события с `seq` > since", schema: { type: "integer" } },
      {
        name: "Last-Event-ID",
        in: "header",
        description: "Стандартный заголовок SSE-реконнекта; важнее `?since=`",
        schema: { type: "integer" },
      },
    ],
    responses: {
      "200": ok("Поток событий (`text/event-stream`)"),
      "404": ok("Сессия не найдена", "ProblemDetails"),
      ...PROBLEM_RESPONSES,
    },
  },
];

/** Уникальные operationId — дубли сломали бы генерацию клиентов. */
export function operationIds(): string[] {
  return OPERATIONS.map((op) => op.operationId);
}
