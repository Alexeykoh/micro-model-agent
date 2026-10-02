// Оркестрация ходов `mma web`: сабмиты, per-session слоты, очереди, дренаж.
// Вынесено из `util.ts` (правило #1: ≤300 строк/файл). В `util.ts` остаются
// чистый транспорт (auth, тела, JSON, ошибки) и `tryOpenBrowser`.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Host } from "../../core/host";
import type { WebUiState, SseEvent } from "./state";
import { broadcast } from "./state";
import {
  releaseBusy,
  reserveBusy,
  sessionStatus,
  syncBusy,
} from "./session-status";
import { makeForwarder } from "./forward";
import { makeRunAgent } from "./run-agent";
import type { SessionRunner } from "../../core/bootstrap/session-runner";
import {
  parseMessageBody,
  readBody,
  readBodyError,
  scrubError,
  sendJson,
} from "./util";

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
function activeSessionOf(s: WebUiState): string | null {
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
 * Переключает серверную активную сессию на `id` (менеджер + план-трекер +
 * штамп `activeSessionId` для SSE-роутинга). Неизвестный id → false, ничего
 * не тронуто. Fail-open по трекеру: сессия переключена, план остался как был.
 * Только legacy-режим без фабрики; фабричные раннеры запинены и не нуждаются.
 */
function switchToSession(s: WebUiState, id: string | null): boolean {
  if (!id) return false;
  const manager = s.sessionManager;
  if (manager) {
    try {
      if (!manager.get(id)) return false;
      manager.setActive(id);
    } catch {
      return false;
    }
  }
  try {
    s.execModule?.switchSession(id);
  } catch {
    /* fail-open */
  }
  s.activeSessionId = id;
  return true;
}

/**
 * Стартует ход в уже зарезервированном слоте: раннер сессии (фабричный режим,
 * настоящий параллелизм) или legacy-мост shared-агента (слот "" / без фабрики
 * с переключением общей активной сессии, как раньше).
 */
function startTurn(
  s: WebUiState,
  target: string | null,
  text: string,
  images: string[],
  token: object,
): void {
  if (target !== null && s.pool.hasFactory()) {
    // Спавн под резервом: второй конкурентный POST видит busy и встаёт
    // в очередь — двойного спавна нет. Упавший спавн отпускает слот сам.
    let runner: SessionRunner;
    try {
      runner = s.pool.getOrCreateRunner(target);
    } catch (err) {
      releaseBusy(s, token, target);
      broadcast({ type: "state", ts: Date.now(), ...sessionStatus(s) }, s);
      throw err;
    }
    runRunnerTurn(s, runner, text, images, target, token);
    return;
  }
  const bridge = s.bridge;
  if (!bridge) {
    // Недостижимо: handleMessagePost отвечает 503 раньше. Гарда ради —
    // слот не висит занятым.
    releaseBusy(s, token, target);
    return;
  }
  if (target) switchToSession(s, target);
  submitLegacy(s, bridge, text, images, target, token);
}

/**
 * Ход фабричного раннера: картинки — в его контекст, события — с явным
 * sessionId (не через activeSessionId-штамп — при параллели он чужой),
 * форвардер и runAgent — свежие на ход (изоляция буферов и id тул-событий).
 */
function runRunnerTurn(
  s: WebUiState,
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
  const sink = (ev: SseEvent): void => {
    broadcast({ sessionId, ...ev }, s);
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
  });
  broadcast({ type: "state", ts: Date.now(), ...sessionStatus(s) }, s);
  runAgent.run(text).catch((err: unknown) => {
    // Тот же контракт владения, что у legacy: turn_end уже сбросил слот —
    // второй error не шлём, репортим только незапустившийся сабмит.
    if (releaseBusy(s, token, sessionId)) {
      broadcast({ type: "error", ts: Date.now(), sessionId, error: scrubError(err) }, s);
      broadcast({ type: "state", ts: Date.now(), ...sessionStatus(s) }, s);
    }
  });
}

/**
 * Legacy-ход через общий мост (слот "" или режим без фабрики).
 */
function submitLegacy(
  s: WebUiState,
  bridge: Host,
  text: string,
  images: string[],
  sessionId: string | null,
  token: object,
): void {
  broadcast({ type: "state", ts: Date.now(), ...sessionStatus(s) }, s);
  const run = Promise.resolve(bridge.submit(text, { images }));
  run.catch((err: unknown) => {
    // Единственный владелец ошибки: для любого реально стартовавшего хода
    // форвардер эмитит `turn_end {success:false}` и первым чистит резерв,
    // так что `releaseBusy` здесь вернёт false и второй `error` слать НЕЛЬЗЯ
    // (браузер показал бы две строки). `error` репортит только сабмит,
    // зареджекченный до начала хода (резерв ещё наш).
    if (releaseBusy(s, token, sessionId)) {
      broadcast({ type: "error", ts: Date.now(), error: scrubError(err) }, s);
      broadcast({ type: "state", ts: Date.now(), ...sessionStatus(s) }, s);
    }
  });
}

/**
 * Завершает ход слота и стартует следующий queued (per-session FIFO).
 * Вызывается из форвардерного `onTurnEnd` (слот уже сброшен форвардером,
 * вызов синхронен, вклиниться некому). Возвращает, стартовал ли ход.
 *
 * Фабричный режим: следующий — голова очереди ТОГО ЖЕ слота (сессии серийны
 * по себе, параллельны между собой). Legacy без фабрики (один shared-агент):
 * следующий — самая ранняя запись по всем слотам (глобальный FIFO, как раньше).
 */
export function finishTurn(s: WebUiState, id: string | null): boolean {
  s.pool.forceRelease(id);
  syncBusy(s);
  broadcast({ type: "state", ts: Date.now(), ...sessionStatus(s) }, s);
  if (s.pool.hasFactory()) {
    const next = s.pool.shift(id);
    if (!next) return false;
    if (next.sessionId && s.sessionManager && !s.sessionManager.get(next.sessionId)) {
      // Сессия исчезла между постановкой и дренажем — дропаем, дальше пусто:
      // в фабричном режиме чужие слоты не трогаем.
      return false;
    }
    const token = reserveBusy(s, id);
    broadcast({ type: "state", ts: Date.now(), ...sessionStatus(s) }, s);
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
  for (;;) {
    const earliest = s.pool.peekEarliest();
    if (!earliest) return false;
    if (earliest.entry.sessionId && s.sessionManager && !s.sessionManager.get(earliest.entry.sessionId)) {
      // Сессия исчезла между постановкой и дренажем — дропаем запись.
      s.pool.shift(earliest.id);
      continue;
    }
    s.pool.shift(earliest.id);
    const token = reserveBusy(s, earliest.id);
    broadcast({ type: "state", ts: Date.now(), ...sessionStatus(s) }, s);
    startTurn(s, earliest.id, earliest.entry.text, earliest.entry.images, token);
    return true;
  }
}

/**
 * Дренаж legacy-слота (""). Гард — защита от чужих вызовов: вызывается
 * синхронно из форвардерного `onTurnEnd` после сброса (см. hook в module.ts).
 */
export function drainQueueTurn(s: WebUiState): boolean {
  if (!s.bridge || s.busy) return false;
  return finishTurn(s, null);
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
  | { text: string; images: string[]; target: string | null }
  | { error: string; status: number };

/**
 * Валидирует тело сообщения: формат, существование сессии, наличие исполнителя.
 * Чистая (без записи состояния) — решение о резерве/очереди принимает диспетчер.
 */
function parsePost(s: WebUiState, raw: string): ParsedPost {
  const body = parseMessageBody(raw);
  if ("error" in body) return { error: body.error, status: 400 };
  const target = extractSessionId(raw) ?? activeSessionOf(s);
  if (target && s.sessionManager && !s.sessionManager.get(target)) {
    return { error: "not_found", status: 404 };
  }
  // Legacy-слот (без сессии) бежит только на общем мосту; сессионные —
  // на фабрике либо (без неё) на мосту с переключением активной.
  if (!s.bridge && (target === null || !s.pool.hasFactory())) {
    return { error: "no_bridge", status: 503 };
  }
  return { text: body.text, images: body.images, target };
}

/**
 * Диспатчит валидное сообщение: в очередь занятого слота или сразу в ход.
 * Проверка занятости и резерв/постановка — синхронно, без await между:
 * иначе два конкурентных POST в одну сессию оба выиграют слот.
 */
function dispatchPost(
  s: WebUiState,
  res: ServerResponse,
  parsed: { text: string; images: string[]; target: string | null },
): void {
  const { text, images, target } = parsed;
  // Без фабрики исполнение серийно глобально (один shared-агент): любой
  // бегущий ход блокирует все слоты, очередь — per-session. С фабрикой
  // слоты независимы: занятость проверяется только по своему.
  const blocked = s.pool.hasFactory() ? s.pool.isBusy(target) : s.pool.anyBusy();
  if (blocked) {
    // Слот занят: сообщение встаёт в очередь входящих вместо `409 busy`.
    const pos = s.pool.enqueue(target, text, images, target);
    if (pos === null) {
      sendJson(res, 429, { error: "queue_full" });
      return;
    }
    broadcast({ type: "state", ts: Date.now(), ...sessionStatus(s) }, s);
    const queuedForSession = target ? s.pool.queueLen(target) : pos;
    sendJson(res, 202, { ok: true, queued: s.pool.totalQueued(), sessionId: target, queuedForSession });
    return;
  }
  const token = reserveBusy(s, target);
  broadcast({ type: "state", ts: Date.now(), ...sessionStatus(s) }, s);
  try {
    startTurn(s, target, text, images, token);
  } catch {
    sendJson(res, 500, { error: "spawn_failed" });
    return;
  }
  sendJson(res, 202, { ok: true, sessionId: target });
}

export function handleMessagePost(req: IncomingMessage, res: ServerResponse, s: WebUiState): void {
  if (s.setupRequired) {
    sendJson(res, 409, { error: "setup_required" });
    return;
  }
  readBody(req, s.maxBodyBytes)
    .then((raw) => {
      const parsed = parsePost(s, raw);
      if ("error" in parsed) {
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
