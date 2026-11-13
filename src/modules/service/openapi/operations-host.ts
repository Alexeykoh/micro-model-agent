/**
 * Host-wire операции `/v1/host/*` (split W2) — вынесены из `operations.ts`
 * по правилу ≤300 строк; порядок внутри файла не важен.
 */
import {
  ok,
  PROBLEM_RESPONSES,
  TOO_LARGE,
  SESSION_ID,
  TENANT_HEADERS,
  type SpecOperation,
} from "./operation-types";

/** Host wire: state, submit, stream, interrupt, pause/resume, answer. */
export const HOST_OPERATIONS: SpecOperation[] = [
  // ── Host wire (split W2) ────────────────────────────────────────────────
  {
    method: "get",
    path: "/v1/host/state",
    operationId: "getHostState",
    tag: "host",
    summary: "Снапшот хоста для тонкого клиента",
    description: "`HostStateSnapshot` + workspace/version/protocol; `?session=` выбирает сессию.",
    params: [
      { name: "session", in: "query", description: "Id сессии (по умолчанию активная)", schema: { type: "string" } },
    ],
    responses: { "200": ok("Снапшот хоста"), ...PROBLEM_RESPONSES },
  },
  {
    method: "post",
    path: "/v1/host/sessions/{sessionId}/submit",
    operationId: "hostSubmit",
    tag: "host",
    summary: "Интерактивный ход через host wire",
    description:
      "Тот же single-flight/FIFO путь, что `POST /v1/sessions/{sessionId}/tasks` с " +
      "`mode: interactive`; `text` обязателен, картинки пока не поддержаны (422).",
    params: [SESSION_ID, ...TENANT_HEADERS],
    requestBody: {
      description: "Текст хода",
      required: true,
      schema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
    },
    responses: {
      "202": ok("Ход принят (`turnId`)"),
      "404": ok("Сессия не найдена", "ProblemDetails"),
      "429": ok("Очередь сессии полна", "ProblemDetails"),
      "413": TOO_LARGE,
      ...PROBLEM_RESPONSES,
    },
  },
  {
    method: "get",
    path: "/v1/host/sessions/{sessionId}/stream",
    operationId: "hostStream",
    tag: "host",
    summary: "SSE-поток событий сессии для host wire",
    description: "Тот же формат и resume, что `GET /v1/sessions/{sessionId}/events`.",
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
  {
    method: "post",
    path: "/v1/host/sessions/{sessionId}/interrupt",
    operationId: "hostInterrupt",
    tag: "host",
    summary: "Прервать бегущий интерактивный ход",
    description: "Идемпотентно: `interrupted: false`, если отменять нечего.",
    params: [SESSION_ID, ...TENANT_HEADERS],
    responses: { "202": ok("Прерывание принято"), ...PROBLEM_RESPONSES },
  },
  {
    method: "post",
    path: "/v1/host/sessions/{sessionId}/pause",
    operationId: "hostPause",
    tag: "host",
    summary: "Поставить ход на паузу",
    description: "Durable-пауза на агенте раннера; `409`, если раннер не поднят.",
    params: [SESSION_ID, ...TENANT_HEADERS],
    responses: {
      "202": ok("Пауза поставлена"),
      "409": ok("Нет активного раннера", "ProblemDetails"),
      ...PROBLEM_RESPONSES,
    },
  },
  {
    method: "post",
    path: "/v1/host/sessions/{sessionId}/resume",
    operationId: "hostResume",
    tag: "host",
    summary: "Снять паузу",
    description: "Идемпотентно; `409`, если раннер не поднят.",
    params: [SESSION_ID, ...TENANT_HEADERS],
    responses: {
      "202": ok("Пауза снята"),
      "409": ok("Нет активного раннера", "ProblemDetails"),
      ...PROBLEM_RESPONSES,
    },
  },
  {
    method: "post",
    path: "/v1/host/sessions/{sessionId}/answer",
    operationId: "hostAnswer",
    tag: "host",
    summary: "Ответ на вопрос интерактивного хода",
    description: "`{id, answer}`; чужой/неизвестный вопрос — `404`.",
    params: [SESSION_ID, ...TENANT_HEADERS],
    requestBody: {
      description: "Ответ на висящий вопрос",
      required: true,
      schema: { type: "object", required: ["id"], properties: { id: { type: "string" }, answer: {} } },
    },
    responses: {
      "202": ok("Ответ принят"),
      "404": ok("Вопрос не найден", "ProblemDetails"),
      "413": TOO_LARGE,
      ...PROBLEM_RESPONSES,
    },
  },  {
    method: "get",
    path: "/v1/host/sessions",
    operationId: "hostListSessions",
    tag: "host",
    summary: "Список сессий демона",
    responses: { "200": ok("Список сессий"), ...PROBLEM_RESPONSES },
  },
  {
    method: "post",
    path: "/v1/host/sessions",
    operationId: "hostCreateSession",
    tag: "host",
    summary: "Создать сессию",
    requestBody: {
      description: "Необязательное имя",
      schema: { type: "object", properties: { name: { type: "string" } } },
    },
    responses: { "201": ok("Сессия создана"), "413": TOO_LARGE, ...PROBLEM_RESPONSES },
  },
  {
    method: "delete",
    path: "/v1/host/sessions/{sessionId}",
    operationId: "hostDeleteSession",
    tag: "host",
    summary: "Удалить простаивающую сессию",
    description: "Занятая сессия → `409`.",
    params: [SESSION_ID],
    responses: {
      "204": ok("Удалена"),
      "404": ok("Сессия не найдена", "ProblemDetails"),
      "409": ok("Сессия занята", "ProblemDetails"),
      ...PROBLEM_RESPONSES,
    },
  },
  {
    method: "get",
    path: "/v1/host/sessions/{sessionId}/history",
    operationId: "hostSessionHistory",
    tag: "host",
    summary: "История диалога сессии",
    params: [SESSION_ID],
    responses: {
      "200": ok("Сообщения сессии"),
      "404": ok("Сессия не найдена", "ProblemDetails"),
      ...PROBLEM_RESPONSES,
    },
  },
  {
    method: "get",
    path: "/v1/host/sessions/{sessionId}/log",
    operationId: "hostSessionLog",
    tag: "host",
    summary: "Хвост session.jsonl",
    params: [
      SESSION_ID,
      { name: "since", in: "query", description: "Записи после ts/ISO", schema: { type: "string" } },
      { name: "limit", in: "query", description: "Сколько последних записей (по умолчанию 200)", schema: { type: "integer" } },
    ],
    responses: {
      "200": ok("Записи журнала"),
      "404": ok("Сессия не найдена", "ProblemDetails"),
      ...PROBLEM_RESPONSES,
    },
  },  {
    method: "get",
    path: "/v1/host/config",
    operationId: "hostConfig",
    tag: "host",
    summary: "Отредактированный конфиг + реестр ключей",
    responses: { "200": ok("Конфиг и реестр"), ...PROBLEM_RESPONSES },
  },
  {
    method: "get",
    path: "/v1/host/models",
    operationId: "hostModels",
    tag: "host",
    summary: "Модели провайдера",
    params: [
      { name: "provider", in: "query", description: "Имя записи провайдера (по умолчанию активный)", schema: { type: "string" } },
    ],
    responses: { "200": ok("Список моделей"), ...PROBLEM_RESPONSES },
  },
];
