/**
 * Токенная бухгалтерия менеджера контекста: кэш оценок, калибровка по usage,
 * пороги компакции и разбивка. Вынесено из `manager.ts` (правило 6); формулы,
 * пороги и safety-clamp не менялись.
 */
import { isImplausibleJump } from "../../core/api";
import type { ContextBudget as ConfigContextBudget } from "../../config/types";
import type { TokenCounter } from "../../llm/token-counter";
import type { ContextBreakdown } from "../../core/types";
import type { Message } from "./message";
import { COMPACTION_INTERVAL, type ContextEstimateDiagnostics } from "./manager-types";
import { calculateBudget, type ContextState } from "./manager-state";

/** Оценка одного сообщения через кэш сигнатуры контента. */
export function estimateMessageTokensCached(s: ContextState, m: Message): number {
  return s.tokenCache.estimate(m, s.tokenCounter ?? null);
}

/** Оценка токенов истории (сообщения + токены тулов). */
export function estimatedTokens(s: ContextState): number {
  return (
    s.messages.reduce((sum, m) => sum + estimateMessageTokensCached(s, m), 0) + s.toolTokens
  );
}

/** Токены системного сообщения (0, если его нет). */
export function systemTokens(s: ContextState): number {
  const sys = s.messages.find((m) => m.role === "system");
  return sys ? estimateMessageTokensCached(s, sys) : 0;
}

/**
 * Токены ИСТОРИИ для порогов: калиброванная оценка минус system и тулы.
 *
 * Сравнивать весь контекст (system + tools + history) с бюджетом истории —
 * двойной счёт: при 30K системных и 30K истории окно 128K «переполнялось» на
 * 60K против бюджета 96K (§3.1 аудита).
 */
export function historyTokensForThresholds(s: ContextState): number {
  if (s.policy !== "v2") {
    return s.messages.reduce((sum, m) => sum + estimateMessageTokensCached(s, m), 0);
  }
  return historyTokens(s);
}

/** Ёмкость истории: окно минус reserve, system и тулы; не выше конфигурной доли. */
export function historyLimit(s: ContextState): number {
  const available = s.contextWindow - s.budget.responseReserve - systemTokens(s) - s.toolTokens;
  return Math.max(0, Math.min(s.budget.history, available));
}

/** True, если истории нужна компакция (бюджет превышен или интервал + загрузка). */
export function needsCompaction(s: ContextState): boolean {
  const tokens = historyTokensForThresholds(s);
  if (tokens > historyLimit(s) * s.compactionThreshold) return true;

  // Интервал итераций уплотняет только значимо загруженную историю.
  // Уплотнять слабозагруженный контекст — терять рабочее состояние без
  // бюджетной причины (см. `compactionMinLoad`).
  if (s.iterationsSinceCompaction < COMPACTION_INTERVAL) return false;
  const limit = historyLimit(s);
  const load = limit > 0 ? tokens / limit : tokens > 0 ? 1 : 0;
  return load >= s.compactionMinLoad;
}

/**
 * Только интервальный триггер (без порога переполнения): итераций прошло
 * достаточно и история значимо загружена. В v2 порог переполнения живёт в
 * отдельной проверке с cooldown, поэтому здесь только интервал.
 */
export function needsIntervalCompaction(s: ContextState): boolean {
  if (s.iterationsSinceCompaction < COMPACTION_INTERVAL) return false;
  const tokens = historyTokensForThresholds(s);
  const limit = historyLimit(s);
  const load = limit > 0 ? tokens / limit : tokens > 0 ? 1 : 0;
  return load >= s.compactionMinLoad;
}

/**
 * Сегментная разбивка контекста: system / tools / history / reserve / free.
 * `used` = все сообщения (включая system) + токены тулов, поэтому
 * `system + tools + history === used` — дерево разбивки сходится.
 */
export function breakdown(s: ContextState): ContextBreakdown {
  const used = estimatedTokens(s);
  const system = systemTokens(s);
  const tools = s.toolTokens;
  const history = Math.max(0, used - system - tools);
  const b = s.budget;
  return {
    system,
    tools,
    history,
    used,
    systemBudget: b.systemPrompt,
    historyBudget: b.history,
    reserve: b.responseReserve,
    free: Math.max(0, s.contextWindow - used - b.responseReserve),
    window: s.contextWindow,
    overcommitted: used > s.contextWindow,
  };
}

/**
 * Калиброванная оценка — вход для порогов компакции. Сырая оценка остаётся
 * в `estimatedTokens()` для бюджета cost-tracking/prefix/critic.
 */
export function contextTokens(s: ContextState): number {
  return s.calibrator.calibrate(estimatedTokens(s), s.messages.length);
}

/** Диагностика оценки контекста (аддитивные поля лога/снимка). */
export function estimateDiagnostics(s: ContextState): ContextEstimateDiagnostics {
  const raw = estimatedTokens(s);
  return {
    raw,
    calibrated: s.calibrator.calibrate(raw, s.messages.length),
    ratio: s.calibrator.getRatio(),
    state: s.calibrator.getState(),
  };
}

/**
 * Проверка порога overflow с safety-clamp: неправдоподобный скачок сырой
 * оценки не запускает компакцию (warn-диагностика в логе). Вызывается один
 * раз на итерацию, обновляет замеренную точку.
 */
export function checkOverflowAllowed(s: ContextState): {
  allowed: boolean;
  raw: number;
  calibrated: number;
  implausible: boolean;
} {
  const raw = estimatedTokens(s);
  const messageCount = s.messages.length;
  const implausible = isImplausibleJump(
    raw,
    s.lastEstimateRaw,
    messageCount,
    s.lastEstimateMessageCount,
  );
  s.lastEstimateRaw = raw;
  s.lastEstimateMessageCount = messageCount;
  s.lastJumpWasImplausible = implausible;
  const calibrated = s.calibrator.calibrate(raw, messageCount);
  // С бюджетом истории сравниваем ТОЛЬКО историю: system и тулы имеют свои
  // бюджеты, иначе переполнение объявляется раньше времени (§3.1 аудита).
  // Предел — ёмкость с учётом измеренных тулов, иначе порог разрешает
  // промпт больше окна (спека 2026-11-01-compaction-history-capacity).
  const tokens = Math.max(0, calibrated - systemTokens(s) - s.toolTokens);
  return {
    allowed: !implausible && tokens > historyLimit(s),
    raw,
    calibrated: tokens,
    implausible,
  };
}

/**
 * Токены истории для порога overflow: `used − system − tools` (калибровано).
 * Эквивалент `breakdown().history` в терминах калиброванной оценки.
 */
export function historyTokens(s: ContextState): number {
  return Math.max(0, contextTokens(s) - systemTokens(s) - s.toolTokens);
}

/** Пересчитывает бюджеты под новое окно контекста (и опционально счётчик). */
export function resizeState(
  s: ContextState,
  contextWindow: number,
  contextBudget?: ConfigContextBudget,
  tokenCounter?: TokenCounter | null,
): void {
  s.contextWindow = contextWindow;
  s.budget = calculateBudget(contextWindow, contextBudget);
  if (tokenCounter !== undefined) {
    s.tokenCounter = tokenCounter ?? null;
  }
  // Reconfigure/смена окна — калибровка недействительна.
  s.calibrator.invalidate();
}

/** Сброс калибровки после мутации истории (компакция/чистка). */
export function invalidateEstimate(s: ContextState): void {
  s.calibrator.invalidate();
  s.lastEstimateRaw = 0;
  s.lastEstimateMessageCount = 0;
}
