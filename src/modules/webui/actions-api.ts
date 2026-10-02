// POST-хендлеры действий `mma web`: команды, interrupt, пересбор индекса.
// Вынесены из `server.ts` (правило #1: ≤300 строк/файл). Чистый транспорт
// поверх состояния — без listen/bind.
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseJsonBody } from "./body";
import { cancelPendingQuestions } from "./prompt-io";
import type { WebUiState } from "./state";
import { readBody, readBodyError, sendJson } from "./util";

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
 */
function maybeAdoptSession(s: WebUiState, sessionId: string | null): void {
  if (!sessionId || s.busy || s.bridge?.isBusy() || !s.sessionManager) return;
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
}

/** Стопает все бегущие слоты (interrupt без `sessionId`). */
function stopAllSlots(s: WebUiState): void {
  for (const id of s.pool.busyIds()) interruptSlot(s, id);
}

/** `POST /api/command` — fire-and-forget диспатч, вывод стримится по SSE. */
export function handleCommandPost(
  req: IncomingMessage,
  res: ServerResponse,
  s: WebUiState,
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
      maybeAdoptSession(s, extractSessionField(raw));
      // Ошибка хоста не должна стать 5xx: POST лишь подтверждает приём,
      // вывод стримится по SSE событиями `command`.
      Promise.resolve(bridge?.executeCommand(line)).catch(() => {});
      sendJson(res, 202, { ok: true });
    })
    .catch((err: unknown) => {
      readBodyError(req, res, err);
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
  s: WebUiState,
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
      readBodyError(req, res, err);
    });
}

/**
 * Останавливает ход слота: scoped shutdown раннера (чужие фоновые процессы
 * живы) + scoped cancel висящих вопросов этой сессии.
 */
function interruptSlot(s: WebUiState, sessionId: string): void {
  const runner = s.pool.getRunner(sessionId);
  if (runner) runner.agent.shutdown(sessionId);
  cancelPendingQuestions(s, sessionId);
}

/** `POST /api/index` — fire-and-forget пересбор индекса; результат виден в `/api/state`. */
export function handleIndexPost(res: ServerResponse, s: WebUiState): void {
  if (!s.refreshIndex) {
    sendJson(res, 503, { error: "unavailable" });
    return;
  }
  Promise.resolve(s.refreshIndex()).catch(() => {});
  sendJson(res, 202, { ok: true });
}
