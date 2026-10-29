// POST-хендлеры действий `mma web`: команды, interrupt, пересбор индекса.
// Вынесены из `server.ts` (правило #1: ≤300 строк/файл). Чистый транспорт
// поверх состояния — без listen/bind.
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseJsonBody } from "../http/body";
import { cancelPendingQuestions } from "../session/prompt-io";
import type { SessionStore, RuntimeState, WorkspaceStore, HttpTransport, SseTransport } from "../state";
import { broadcast } from "../state";
import { readBody, requestError, scrubError, sendJson } from "../util";
import { appendCommandLog, CLIENT_COMMAND_LINES } from "./command-log";

/** Достаёт `sessionId` вкладки-отправителя из JSON-тела (нет — null). */
function extractSessionField(raw: string): string | null {
  if (!raw.trim()) return null;
  const rec = parseJsonBody(raw) ?? {};
  if (typeof rec.sessionId === "string" && rec.sessionId.trim()) {
    return rec.sessionId.trim();
  }
  return null;
}

/**
 * Переключает серверную активную сессию под команду из вкладки — только пока
 * сервер простаивает (ход владеет активной до turn_end). Fail-open.
 *
 * @returns id сессии, под которой выполнится команда (владелец вывода).
 */
function maybeAdoptSession(
  s: SessionStore & RuntimeState & WorkspaceStore & HttpTransport & SseTransport,
  sessionId: string | null,
): string | undefined {
  if (!sessionId || s.busy || s.bridge?.isBusy() || !s.sessionManager) return sessionId ?? undefined;
  try {
    if (s.sessionManager.get(sessionId)) {
      s.sessionManager.setActive(sessionId);
      try {
        s.execModule?.switchSession(sessionId);
      } catch {
        /* fail-open */
      }
      s.activeSessionId = sessionId;
    }
  } catch {
    /* fail-open: команда выполнится в тогда-активной */
  }
  return sessionId ?? undefined;
}

/** Стопает все бегущие слоты (interrupt без `sessionId`). */
function stopAllSlots(s: SessionStore & RuntimeState & WorkspaceStore & HttpTransport & SseTransport): void {
  for (const id of s.pool.busyIds()) interruptSlot(s, id);
}

/** `POST /api/command` — fire-and-forget диспатч, вывод стримится по SSE. */
export function handleCommandPost(
  req: IncomingMessage,
  res: ServerResponse,
  s: SessionStore & RuntimeState & WorkspaceStore & HttpTransport & SseTransport,
): void {
  if (s.setupRequired) {
    sendJson(res, 409, { error: "setup_required" });
    return;
  }
  const bridge = s.bridge;
  readBody(req, s.maxBodyBytes)
    .then((raw) => {
      const rec = parseJsonBody(raw) ?? {};
      // Битое тело: диспатчер игнорирует не-слеш строку, так что это безвредный
      // no-op, а не 400.
      const line = typeof rec.line === "string" ? rec.line : "";
      const sessionId = maybeAdoptSession(s, extractSessionField(raw));
      // Client-only commands (`/clear`, `/new`) execute in the browser; this
      // dedicated action exists so the session journal still records them (B-35).
      // The server does not clear anything here.
      const action = typeof rec.action === "string" ? rec.action : "";
      if (action) {
        const clientLine = CLIENT_COMMAND_LINES[action];
        if (!clientLine) {
          sendJson(res, 400, { error: "unknown_action" });
          return;
        }
        appendCommandLog(s, clientLine, true, "client-side");
        sendJson(res, 202, { ok: true });
        return;
      }
      // Ошибка хоста не должна стать 5xx: POST лишь подтверждает приём,
      // вывод стримится по SSE событиями `command`. Но ошибка не должна и
      // пропасть — она уходит в ленту владельца-сессии (аудит §6.17).
      Promise.resolve(bridge?.executeCommand(line)).catch((err: unknown) => {
        broadcast(
          { type: "error", ts: Date.now(), error: scrubError(err), sessionId: sessionId ?? undefined },
          s,
        );
      });
      sendJson(res, 202, { ok: true });
    })
    .catch((err: unknown) => {
      requestError(req, res, err);
    });
}

/**
 * `POST /api/interrupt [ {sessionId?} ]` — аборт бегущего хода без раннего разлока.
 * С sessionId — только свой слот: чужой параллельный ход не трогаем, отвечаем
 * 409 `idle`, чтобы Esc в idle-вкладке не убивал работу соседней. Без sessionId
 * — стопаем все бегущие слоты.
 */
export function handleInterruptPost(
  req: IncomingMessage,
  res: ServerResponse,
  s: SessionStore & RuntimeState & WorkspaceStore & HttpTransport & SseTransport,
): void {
  readBody(req, s.maxBodyBytes)
    .then((raw) => {
      const sessionId = extractSessionField(raw);
      if (sessionId !== null) {
        if (!s.pool.isBusy(sessionId)) {
          sendJson(res, 409, { error: "idle" });
          return;
        }
        interruptSlot(s, sessionId);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (!s.pool.anyBusy()) {
        sendJson(res, 409, { error: "idle" });
        return;
      }
      // `busy` здесь НЕ чистим: сбросом владеет форвардерный `onTurnEnd` для любого
      // реально стартовавшего хода. Очистка сейчас разлочила бы UI, пока абортнутый
      // ход ещё разматывается, и второй сабмит проскочил бы. Если хост реально не
      // бежит (только резерв), `interrupt()` — no-op, и слот отпустит путь висящего сабмита.
      stopAllSlots(s);
      sendJson(res, 200, { ok: true });
    })
    .catch((err: unknown) => {
      requestError(req, res, err);
    });
}

/**
 * Останавливает ход слота: scoped shutdown раннера (чужие фоновые процессы
 * живы) + scoped cancel висящих вопросов этой сессии.
 */
export function interruptSlot(s: SessionStore & RuntimeState & WorkspaceStore & HttpTransport & SseTransport, sessionId: string): void {
  const runner = s.pool.getRunner(sessionId);
  if (runner) runner.agent.shutdown(sessionId);
  cancelPendingQuestions(s, sessionId);
}

/** `POST /api/index` — fire-and-forget пересбор индекса; результат виден в `/api/state`. */
export function handleIndexPost(res: ServerResponse, s: SessionStore & RuntimeState & WorkspaceStore & HttpTransport & SseTransport): void {
  if (!s.refreshIndex) {
    sendJson(res, 503, { error: "unavailable" });
    return;
  }
  Promise.resolve(s.refreshIndex()).catch(() => {});
  sendJson(res, 202, { ok: true });
}
