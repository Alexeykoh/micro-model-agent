// Оркестрация ходов `mma web`: сабмиты, per-session слоты, очереди, дренаж.
// Вынесено из `util.ts` (правило #1: ≤300 строк/файл). В `util.ts` остаются
// чистый транспорт (auth, тела, JSON, ошибки) и `tryOpenBrowser`.
//
// Web ВСЕГДА идёт через per-session раннер (`SessionRunner`): legacy-путь
// однo-сессионного main-агента удалён. Главный агент обслуживает только CLI/REPL
// (и хост-команды/плагины), не ходы браузера.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionStore, RuntimeState, ConfigStore, HttpTransport, SseTransport, WorkspaceStore, SseEvent } from "../state";
import { broadcast } from "../state";
import { pushState, releaseBusy, reserveBusy, syncBusy } from "./session-status";
import { makeForwarder } from "./forward";
import { makeRunAgent } from "./run-agent";
import type { SessionRunner } from "../../../core/bootstrap/session-runner";
import { beginEgressTurn, endEgressTurn } from "../../security/data-policy/turn-journal";
import { attachEgressTurn } from "./egress-turn";
import {
  parseMessageBody,
  readBody,
  readBodyError,
  scrubError,
  sendJson,
} from "../util";
import { t } from "../../../i18n/index";

/**
 * Достаёт `sessionId` из сырого JSON-тела (фронт шлёт вкладку-владельца).
 * Пусто/мусор → null (фолбэк — тогда-активная). Битый JSON отдаст
 * `parseMessageBody`, здесь не шумим. Прямой `JSON.parse`, а не `parseJsonBody`:
 * `body.ts` импортирует `readBody` из `util.ts`, обратный импорт дал бы цикл.
 */
function extractSessionId(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const id = (parsed as Record<string, unknown>).sessionId;
      if (typeof id === "string" && id.trim()) return id.trim();
    }
  } catch {
    /* invalid JSON — разберёт parseMessageBody */
  }
  return null;
}

/** Тогда-активная сессия (фолбэк, когда фронт sessionId не прислал). */
function activeSessionOf(s: SessionStore & RuntimeState & ConfigStore & HttpTransport & SseTransport & WorkspaceStore): string | null {
  try {
    const manager = s.sessionManager as unknown as
      | { getActive?: () => string | null; getActiveMeta?: () => { id: string } | null }
      | undefined;
    return manager?.getActive?.() ?? manager?.getActiveMeta?.()?.id ?? s.activeSessionId ?? null;
  } catch {
    return s.activeSessionId ?? null;
  }
}

/**
 * Стартует ход в уже зарезервированном слоте сессии: спавн/подъём её раннера.
 * `target` всегда конкретная сессия (слот может быть `null` только в тестах
 * через `finishTurn` — ключ слота при этом `""`).
 */
function startTurn(
  s: SessionStore & RuntimeState & ConfigStore & HttpTransport & SseTransport & WorkspaceStore,
  target: string | null,
  text: string,
  images: string[],
  token: object,
): void {
  const sessionId = target ?? "";
  let runner: SessionRunner;
  try {
    runner = s.pool.getOrCreateRunner(sessionId);
  } catch (err) {
    releaseBusy(s, token, target);
    pushState(s, target);
    throw err;
  }
  runRunnerTurn(s, runner, text, images, sessionId, token);
}

/**
 * Ход фабричного раннера: картинки — в его контекст, события — с явным
 * sessionId (не через activeSessionId-штамп — при параллели у него чужой),
 * форвардер и runAgent — свежие на ход (изоляция буферов и id тул-событий).
 */
function runRunnerTurn(
  s: SessionStore & RuntimeState & ConfigStore & HttpTransport & SseTransport & WorkspaceStore,
  runner: SessionRunner,
  text: string,
  images: string[],
  sessionId: string,
  token: object,
): void {
  for (const url of images) {
    runner.contextManager.addPendingImage({ type: "image_url", image_url: { url } });
  }
  s.activeSessionId = sessionId;
  const dlpEnabled = s.config?.security?.dataPolicy?.enabled ?? true;
  if (dlpEnabled) beginEgressTurn(sessionId);
  const sink = (ev: SseEvent): void => {
    const withEgress = attachEgressTurn(runner.sessionManager, sessionId, ev);
    broadcast({ sessionId, ...withEgress }, s);
  };
  const ownerRef = { current: sessionId as string | null };
  const forwarder = makeForwarder(s, sink, {
    onQueueDrained: (owner) => finishTurn(s, owner),
    ownerRef,
  });
  const runAgent = makeRunAgent({
    agent: runner.agent,
    state: s,
    forwarder,
    ownerSessionId: sessionId,
    ownerRef,
    execModule: runner.execModule,
    contextWindow: s.config?.contextWindow,
    contextManager: runner.contextManager,
  });
  pushState(s, sessionId);
  runAgent.run(text).catch((err: unknown) => {
    // Ход не дошёл до turn_end — агрегат DLP отбрасываем, чтобы он не попал
    // в следующий ход этой сессии.
    if (dlpEnabled) endEgressTurn(sessionId);
    // Тот же контракт владения, что у legacy: turn_end уже сбросил слот —
    // второй error не шлём, репортим только незапустившийся сабмит.
    if (releaseBusy(s, token, sessionId)) {
      broadcast({ type: "error", ts: Date.now(), sessionId, error: scrubError(err) }, s);
      pushState(s, sessionId);
    }
  });
}

/**
 * Завершает ход слота и стартует следующий queued (per-session FIFO).
 * Вызывается из форвардерного `onTurnEnd` (слот уже сброшен форвардером,
 * вызов синхронен, вклиниться некому). Возвращает, стартовал ли ход.
 */
export function finishTurn(s: SessionStore & RuntimeState & ConfigStore & HttpTransport & SseTransport & WorkspaceStore, id: string | null): boolean {
  s.pool.forceRelease(id);
  syncBusy(s);
  pushState(s, id);
  const next = s.pool.shift(id);
  if (!next) return false;
  if (next.sessionId && s.sessionManager && !s.sessionManager.get(next.sessionId)) {
    // Сессия исчезла между постановкой и дренажем — дропаем запись.
    return false;
  }
  const token = reserveBusy(s, id);
  pushState(s, id);
  try {
    startTurn(s, id, next.text, next.images, token);
  } catch {
    // Спавн упал после резерва (сессия испарилась): слот уже отпущен
    // в startTurn, запись дропнута — сообщаем владельцу в ленту.
    broadcast(
      { type: "error", ts: Date.now(), sessionId: id, error: "spawn_failed" },
      s,
    );
    return false;
  }
  return true;
}

/**
 * `POST /api/message`: ход — сразу в свободный слот сессии, иначе в её очередь.
 *
 * Параллелизм per-session: слоты разных сессий не блокируют друг друга —
 * занятость проверяется только по слоту-владельцу. Атомарность решения
 * (проверка + резерв/постановка — синхронно, без await между) не даёт двум
 * конкурентным POST в одну сессию оба выиграть слот.
 *
 * Ход идёт — сообщение не отклоняется `409 busy`, а встаёт в очередь входящих
 * (`202 {queued: n}`) и выполняется следующим ходом по завершении текущего.
 * Хвост сверх `MAX_QUEUE_LENGTH` — `429 queue_full`.
 */
/** Разобранное тело `POST /api/message`: текст, картинки, сессия-владелец. */
type ParsedPost =
  | { text: string; images: string[]; target: string }
  | { error: string; status: number };

/**
 * Валидирует тело сообщения: формат, существование сессии, наличие раннера.
 * Чистая (без записи состояния) — решение о резерве/очереди принимает диспетчер.
 */
function parsePost(s: SessionStore & RuntimeState & ConfigStore & HttpTransport & SseTransport & WorkspaceStore, raw: string): ParsedPost {
  const body = parseMessageBody(raw);
  if ("error" in body) return { error: body.error, status: 400 };
  const target = extractSessionId(raw) ?? activeSessionOf(s);
  if (!target) return { error: "no_session", status: 503 };
  if (s.sessionManager && !s.sessionManager.get(target)) {
    return { error: "not_found", status: 404 };
  }
  // Web всегда через раннер: без фабрики исполнителя нет.
  if (!s.pool.hasFactory()) return { error: "no_runner", status: 503 };
  return { text: body.text, images: body.images, target };
}

/**
 * Диспатчит валидное сообщение: в очередь занятого слота или сразу в ход.
 * Проверка занятости и резерв/постановка — синхронно, без await между:
 * иначе два конкурентных POST в одну сессию оба выиграют слот.
 */
function dispatchPost(
  s: SessionStore & RuntimeState & ConfigStore & HttpTransport & SseTransport & WorkspaceStore,
  res: ServerResponse,
  parsed: { text: string; images: string[]; target: string },
): void {
  const { text, images, target } = parsed;
  // Слоты независимы: занятость — только по своему.
  const blocked = s.pool.isBusy(target);
  if (blocked) {
    // Слот занят: сообщение встаёт в очередь входящих вместо `409 busy`.
    const queued = s.pool.enqueue(target, text, images, target);
    if (queued === null) {
      sendJson(res, 429, { error: "queue_full" });
      return;
    }
    pushState(s, target);
    sendJson(res, 202, {
      ok: true,
      queued: s.pool.totalQueued(),      sessionId: target,
      queuedForSession: s.pool.queueLen(target),
      id: queued.id,
    });
    return;
  }
  const token = reserveBusy(s, target);
  pushState(s, target);
  try {
    startTurn(s, target, text, images, token);
  } catch {
    sendJson(res, 500, { error: "spawn_failed" });
    return;
  }
  sendJson(res, 202, { ok: true, sessionId: target });
}

export function handleMessagePost(req: IncomingMessage, res: ServerResponse, s: SessionStore & RuntimeState & ConfigStore & HttpTransport & SseTransport & WorkspaceStore): void {
  if (s.setupRequired) {
    sendJson(res, 409, { error: "setup_required" });
    return;
  }
  readBody(req, s.maxBodyBytes)
    .then((raw) => {
      const parsed = parsePost(s, raw);
      if ("error" in parsed) {
        // Пустой ввод — no-op с локализованной подсказкой, без LLM-вызова.
        if (parsed.error === "empty") {
          sendJson(res, 200, { ok: true, noop: true, notice: t("web.message_empty") });
          return;
        }
        sendJson(res, parsed.status, { error: parsed.error });
        return;
      }
      if (s.minPostIntervalMs > 0 && Date.now() - s.lastPostTs < s.minPostIntervalMs) {
        sendJson(res, 429, { error: "rate_limited" });
        return;
      }
      s.lastPostTs = Date.now();
      dispatchPost(s, res, parsed);
    })
    .catch((err: unknown) => {
      readBodyError(req, res, err);
    });
}
