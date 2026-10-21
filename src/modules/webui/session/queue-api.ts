// Управление очередью сообщений `mma web`: отмена и принудительный старт.
//
// Очередь — per-session FIFO в `RunPool`. Оба действия адресуются стабильным
// `id` сообщения, а не позицией: пока клиент рисует полосу, голова очереди
// может стартовать, и индекс уже указывал бы на другое сообщение.
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseJsonBody } from "../http/body";
import { readBody, requestError, sendJson } from "../util";
import type {
  SessionStore,
  RuntimeState,
  ConfigStore,
  HttpTransport,
  SseTransport,
  WorkspaceStore,
} from "../state";
import { pushState } from "./session-status";
import { finishTurn } from "./turns";
import { interruptSlot } from "../chat/actions-api";

type QueueState = SessionStore &
  RuntimeState &
  ConfigStore &
  HttpTransport &
  SseTransport &
  WorkspaceStore;

/** Разобранное действие: сессия-владелец и id сообщения. */
interface QueueAction {
  sessionId: string;
  id: string;
}

/** Валидирует тело `{sessionId, id}`; null — неверная форма. */
function parseAction(raw: string): QueueAction | null {
  const rec = parseJsonBody(raw);
  if (!rec) return null;
  const sessionId = typeof rec.sessionId === "string" ? rec.sessionId.trim() : "";
  const id = typeof rec.id === "string" ? rec.id.trim() : "";
  if (!sessionId || !id) return null;
  return { sessionId, id };
}

/**
 * Общий каркас POST-действия: setup-гейт, чтение тела, ошибки транспорта.
 * `act` возвращает, обработан ли запрос.
 */
function handleAction(
  req: IncomingMessage,
  res: ServerResponse,
  s: QueueState,
  act: (action: QueueAction) => void,
): void {
  if (s.setupRequired) {
    sendJson(res, 409, { error: "setup_required" });
    return;
  }
  readBody(req, s.maxBodyBytes)
    .then((raw) => {
      const action = parseAction(raw);
      if (!action) {
        sendJson(res, 400, { error: "bad_request" });
        return;
      }
      act(action);
    })
    .catch((err: unknown) => {
      requestError(req, res, err);
    });
}

/**
 * `POST /api/queue/cancel {sessionId, id}` — убирает сообщение из очереди.
 * В ленту оно не попадает: хода не было.
 */
export function handleQueueCancel(req: IncomingMessage, res: ServerResponse, s: QueueState): void {
  handleAction(req, res, s, ({ sessionId, id }) => {
    const removed = s.pool.removeQueued(sessionId, id);
    if (!removed) {
      sendJson(res, 404, { error: "not_queued" });
      return;
    }
    pushState(s, sessionId);
    sendJson(res, 200, { ok: true });
  });
}

/**
 * `POST /api/queue/start {sessionId, id}` — запускает сообщение следующим.
 *
 * Сначала переносим в голову, затем (если слот занят) абортим текущий ход:
 * штатный `turn_end` дренаж поднимет именно голову. Если слот уже свободен
 * (гонка с естественным завершением), стартуем сразу через `finishTurn`.
 */
export function handleQueueStart(req: IncomingMessage, res: ServerResponse, s: QueueState): void {
  handleAction(req, res, s, ({ sessionId, id }) => {
    if (!s.pool.promoteQueued(sessionId, id)) {
      sendJson(res, 404, { error: "not_queued" });
      return;
    }
    if (s.pool.isBusy(sessionId)) {
      interruptSlot(s, sessionId);
      pushState(s, sessionId);
      sendJson(res, 202, { ok: true, starting: true });
      return;
    }
    const started = finishTurn(s, sessionId);
    sendJson(res, 200, { ok: true, started });
  });
}
