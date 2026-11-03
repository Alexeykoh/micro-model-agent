/**
 * Операции над историей менеджера контекста: добавление сообщения, трекинг
 * задачи/фидбека юзера, сброс хода и полный clear. Вынесено из `manager.ts`
 * (правило 6); порядок побочных эффектов и границы — те же.
 */
import { getMessageText, type TextPart } from "../../llm/provider";
import { ContextCalibrator } from "../../core/api";
import { looksLikeErrorPaste } from "./message-analysis";
import { observeToolResult } from "./ledger-absorb";
import type { Message } from "./message";
import type { ContextState } from "./manager-state";
import { estimatedTokens } from "./manager-estimate";

/** Ставит монотонный seq в реестр и возвращает сообщение. */
export function stampSeq<T extends Message>(s: ContextState, msg: T): T {
  return s.book.stamp(msg);
}

/** Добавляет сообщение в историю (трекает задачу, аттачит pending-картинки, пик токенов). */
export function addMessage(s: ContextState, msg: Message): void {
  // Трекаем задачу, над которой работает агент, чтобы пережила компакцию.
  // Реальная инструкция юзера — ПЕРВОЕ не-system-summary user-сообщение хода;
  // всё после (результаты тулов, retry-nudge'и) — инжектированные `user`-
  // конверты, которые не должны её затирать (было: после компакции модель
  // забывала "удали /bicycles, почини стили" и 40+ итераций бесцельно читала файлы).
  if (msg.role === "user") {
    const text = typeof msg.content === "string" ? msg.content : getMessageText(msg.content);
    // Инъекция харнесса — в журнал: ровно тот текст, который увидит провайдер.
    if (text.startsWith("<system-summary>") && s.harnessSink) {
      s.harnessSink(text);
    }
    if (text.trim() && !text.startsWith("<system-summary>") && !text.includes("[Compressed:")) {
      if (looksLikeErrorPaste(text) && (s.lastUserTask || s.sessionMission)) {
        s.lastUserFeedback = text.trim().slice(0, 400);
      } else if (!s.lastUserTask && !s.lastUserFeedback) {
        // Нет новой задачи внутри хода, где уже поймана вставка ошибки/лога:
        // последующие сообщения — продолжения результатов тулов, не свежая
        // инструкция, поэтому на компакции побеждает миссия сессии.
        s.lastUserTask = text.trim();
        if (!s.sessionMission) s.sessionMission = text.trim();
      }
    }
  }
  // Авто-аттач pending-картинок к следующему user-сообщению
  if (msg.role === "user" && s.pendingImages.has()) {
    const textPart: TextPart = {
      type: "text",
      text: typeof msg.content === "string" ? msg.content : getMessageText(msg.content),
    };
    msg = {
      ...msg,
      content: [textPart, ...s.pendingImages.takeAll()],
    };
  }
  s.messages.push(stampSeq(s, msg));
  s.book.note(s.messages[s.messages.length - 1]);
  // OO-3/OO-8: адреса-находки пишутся сразу (сырой контент), правка — stale.
  observeToolResult(s.ledger, msg);
  const tokens = estimatedTokens(s);
  if (tokens > s.peakTokens) s.peakTokens = tokens;
}

/**
 * Начинает свежий ход юзера. 15-итерационный интервал компакции не должен
 * течь через сообщения юзера — иначе ход, кончившийся на итерации 14,
 * форсит компакцию на первой же итерации следующего сообщения (было:
 * компакция на итерации 8 нового хода снесла свежеприсланную задачу юзера
 * вместе с 40+ старыми ходами). Факты сохраняются.
 */
export function resetUserTurn(s: ContextState): void {
  s.iterationsSinceCompaction = 0;
  // Новое сообщение юзера начинает новый ход — сбрасываем задачу прошлого хода,
  // чтобы сводка сохранила свежую инструкцию. Миссия сессии выживает: вставка
  // ошибки/лога в новом ходе не должна стирать исходную цель.
  s.lastUserTask = "";
  s.lastUserFeedback = "";
}

/**
 * Заменяет системный промпт на месте (остаётся первым) или пренпендит новый.
 * Обновляет динамические блоки промпта (напр. чеклист плана) посреди прогона.
 */
export function updateSystemPrompt(s: ContextState, content: string): void {
  const idx = s.messages.findIndex((m) => m.role === "system");
  if (idx >= 0) {
    s.messages[idx] = { ...s.messages[idx], content };
  } else {
    s.messages.unshift(stampSeq(s, { role: "system", content }));
  }
  // Baseline калибровки НЕ сбрасываем: схема baseline+delta инвариантна к
  // составу промпта (raw пересчитывается с новым system, дельта корректна).
  // Сброс на каждый плановый чеклист держал бы калибровку вечно в warmup.
}

/**
 * Сбрасывает всё, что принадлежит текущему ходу диалога.
 * Списки фактов (FactExtractor) осознанно переживают clear() — это
 * session-scoped состояние компакции, не per-turn.
 */
export function clearState(s: ContextState): void {
  s.messages = [];
  s.compactedBlock = null;
  s.book.reset();
  // Pending-картинки прошлого хода не должны утечь в следующий (§3.5).
  s.pendingImages.clear();
  s.toolLedger = [];
  s.toolLedgerKeys = new Set();
  s.iterationsSinceCompaction = 0;
  s.compactionCount = 0;
  s.peakTokens = 0;
  s.lastUserTask = "";
  s.lastUserFeedback = "";
  s.sessionMission = "";
  s.calibrator = new ContextCalibrator(s.calibrationOptions);
  s.lastEstimateRaw = 0;
  s.lastEstimateMessageCount = 0;
  s.lastJumpWasImplausible = false;
  s.compactionProgress.reset();
}

