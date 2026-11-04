/**
 * Тексты и классификация причин застревания: приоритет причины, варнинг,
 * recovery-сообщения, диагностический маркер.
 *
 * Вынесено из `stuck-detector.ts` (правило 6): чистые функции над состоянием
 * `StuckTracker` — без собственного состояния и побочных эффектов.
 */
import { t } from "../../i18n/index";
import type { FailureClassification } from "./stuck-signals";
import type { StuckTracker } from "./stuck-tracker";

/** Первичная причина застревания (приоритет recovery-гайденса). */
export type PrimaryReason =
  | "stuck"
  | "tool-errors"
  | "consecutive"
  | "repetitive"
  | "bash-flailing"
  | null;

/** Первый тул, чей счётчик ошибок достиг порога, или undefined. */
function errorToolAtThreshold(
  tracker: StuckTracker,
): [string, number] | undefined {
  return Array.from(tracker.toolErrors.entries()).find(
    ([, c]) => c >= tracker.errorThreshold,
  );
}

/**
 * Единый источник правды приоритета recovery-причины. Общий для
 * `recoveryMessage()` и `hints()`, чтобы не расходились: bullet состояния,
 * которое recovery уже репортит, хинтом НЕ дублируется
 * (приоритет: stuck > tool-errors > bash-flailing > consecutive > repetitive).
 */
export function primaryReason(tracker: StuckTracker): PrimaryReason {
  if (tracker.isStuck()) return "stuck";
  if (errorToolAtThreshold(tracker)) return "tool-errors";
  if (tracker.observations.hasBashFlailing()) return "bash-flailing";
  if (tracker.hasConsecutiveFailures()) return "consecutive";
  if (tracker.hasRepetitiveToolCalls()) return "repetitive";
  return null;
}

/** Сообщение о повторяющемся туле (+хинт про process_wait для process_log). */
export function repetitiveToolMessage(tracker: StuckTracker): string {
  if (!tracker.hasRepetitiveToolCalls()) return "";
  const last = tracker.recentToolCalls[tracker.recentToolCalls.length - 1];
  const base = t("exec.repetitive_tool", {
    tool: last.name,
    count: tracker.repetitionThreshold,
  });
  // Опрос фонового процесса по одному process_log за раз жжёт LLM-вызов на
  // опрос — указываем на одиночное блокирующее ожидание.
  if (last.name === "process_log") {
    return `${base} ${t("exec.repetitive_process_log_hint")}`;
  }
  return base;
}

/**
 * Стабильная идентичность варнинга для анти-спам дедупа: тот же ключ каждую
 * итерацию — спам, НОВЫЙ ключ (или длинная пауза) заслуживает re-warn.
 */
export function warningKey(tracker: StuckTracker): string {
  if (tracker.isStuck()) return "stuck";
  const errorTool = errorToolAtThreshold(tracker);
  if (errorTool) return `tool-errors:${errorTool[0]}`;
  if (tracker.observations.hasBashFlailing()) return "bash-flailing";
  if (tracker.hasConsecutiveFailures()) return "consecutive";
  if (tracker.hasRepetitiveToolCalls()) return "repetitive";
  return "";
}

/** Причина застревания для лога (пусто если здоров). */
export function stuckReason(tracker: StuckTracker): string {
  if (tracker.isStuck()) {
    return t("exec.stuck", {
      stepId: String(tracker.currentStepId ?? "?"),
      description: tracker.currentStepDescription,
      iterations: tracker.iterationsOnCurrentStep,
    });
  }
  const errorTool = errorToolAtThreshold(tracker);
  if (errorTool) {
    return t("exec.tool_errors", { tool: errorTool[0], count: errorTool[1] });
  }
  if (tracker.observations.hasBashFlailing()) {
    const fails = tracker.observations.bashRecent.filter((ok) => !ok).length;
    return t("exec.bash_flailing", {
      fails: String(fails),
      window: String(tracker.observations.bashRecent.length),
    });
  }
  if (tracker.hasConsecutiveFailures()) {
    return t("exec.consecutive_failures", { count: String(tracker.consecutiveFailures) });
  }
  // Повторные идентичные вызовы — петля, даже если ничего не фейлится (напр.
  // цикл опроса process_log): без этой ветки оставались невидимы —
  // warningKey репортил "repetitive", но причина не логгировалась.
  if (tracker.hasRepetitiveToolCalls()) {
    return repetitiveToolMessage(tracker);
  }
  return "";
}

/** Recovery-сообщение по первичной причине (пусто если здоров). */
export function recoveryMessage(tracker: StuckTracker): string {
  const reason = primaryReason(tracker);
  if (reason === "stuck") {
    return t("exec.stuck_recovery", {
      iterations: tracker.iterationsOnCurrentStep,
      stepId: String(tracker.currentStepId ?? "?"),
      description: tracker.currentStepDescription,
    });
  }
  // Per-tool recovery (конкретнее — напр. "bash упал 3 раза")
  if (reason === "tool-errors") {
    const errorTool = errorToolAtThreshold(tracker)!;
    return t("exec.tool_errors_recovery", {
      tool: errorTool[0],
      count: errorTool[1],
    });
  }
  // Подряд фейлы разных тулов (общее — напр. "5 consecutive failures")
  if (reason === "consecutive") {
    return t("exec.consecutive_failures_recovery", {
      count: tracker.consecutiveFailures,
    });
  }
  if (reason === "bash-flailing") {
    const fails = tracker.observations.bashRecent.filter((ok) => !ok).length;
    return t("exec.bash_flailing_recovery", {
      fails: String(fails),
      window: String(tracker.observations.bashRecent.length),
    });
  }
  if (reason === "repetitive") {
    return repetitiveToolMessage(tracker);
  }
  return "";
}

/**
 * Классифицирует текущее состояние фейла в стабильный `FailureType`
 * для диагностики/логов. Null если здоров. `iteration` даёт вызывающий
 * (детектор глобальный счётчик цикла не ведёт).
 */
export function classifyFailure(
  tracker: StuckTracker,
  iteration = 0,
): FailureClassification | null {
  const primary = primaryReason(tracker);
  if (!primary) return null;
  switch (primary) {
    case "stuck":
      return { type: "timeout", iteration };
    case "tool-errors": {
      const entry = errorToolAtThreshold(tracker);
      return { type: "error_loop", tool: entry?.[0], count: entry?.[1], iteration };
    }
    case "consecutive":
      return { type: "error_loop", count: tracker.consecutiveFailures, iteration };
    case "repetitive": {
      const last = tracker.recentToolCalls[tracker.recentToolCalls.length - 1];
      return { type: "repeat", tool: last?.name, count: tracker.repetitionThreshold, iteration };
    }
    case "bash-flailing": {
      const fails = tracker.observations.bashRecent.filter((ok) => !ok).length;
      return { type: "bash_flailing", count: fails, iteration };
    }
  }
}

/** Компактный маркер `[STUCK: type=..., tool=..., count=..., iteration=N]`. */
export function formatFailureDiagnostic(c: FailureClassification): string {
  const parts = [`type=${c.type}`];
  if (c.tool) parts.push(`tool=${c.tool}`);
  if (typeof c.count === "number") parts.push(`count=${c.count}`);
  if (c.iteration > 0) parts.push(`iteration=${c.iteration}`);
  return `[STUCK: ${parts.join(", ")}]`;
}

/** Диагностический маркер текущего состояния, или "" если здоров. */
export function stuckDiagnostic(tracker: StuckTracker, iteration = 0): string {
  const c = classifyFailure(tracker, iteration);
  return c ? formatFailureDiagnostic(c) : "";
}
