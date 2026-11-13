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
  },
];
