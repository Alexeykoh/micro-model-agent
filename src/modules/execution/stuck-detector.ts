// Детектор застревания: повторы, фейлы, bash-флейлинг, хинты.
import type { FailureClassification } from "./stuck-signals";
import { StuckTracker } from "./stuck-tracker";
import { actionableHints, hints, toolAlternative } from "./stuck-hints";
import {
  classifyFailure as classify,
  formatFailureDiagnostic as formatDiagnostic,
  recoveryMessage,
  repetitiveToolMessage,
  stuckDiagnostic,
  stuckReason,
  warningKey,
} from "./stuck-recovery";

export {
  classifyError,
  normalizeErrorSignature,
  isSearchableError,
  buildSearchQuery,
  type ErrorClassification,
  type FailureType,
  type FailureClassification,
} from "./stuck-signals";

/**
 * Детектор застревания: счётчики итераций, ошибок, повторов, петель,
 * эскалаций.
 *
 * Учёт состояния — `StuckTracker` (`stuck-tracker.ts`), тексты и
 * классификация — `stuck-recovery.ts`, хинты — `stuck-hints.ts` (правило 6).
 * Публичный API класса не менялся: методы остаются здесь.
 */
export class StuckDetector extends StuckTracker {
  /** Записывает каждый вызов bash (для пустых прогонов и entry-point). */
  recordBashOutput(command: string, output: string): void {
    this.observations.recordBashOutput(command, output);
  }

  /** Исход одной bash-попытки (успех/фейл) — для детекции флейлинга. */
  recordBashAttempt(success: boolean): void {
    this.observations.recordBashAttempt(success);
  }

  /** True, если свежие bash-попытки в массе фейлятся — модель флейлит. */
  hasBashFlailing(): boolean {
    return this.observations.hasBashFlailing();
  }

  /** Последняя bash-команда. */
  getLastBashCommand(): string {
    return this.observations.lastBashCommand;
  }

  /** Вывод последней bash-команды. */
  getLastBashOutput(): string {
    return this.observations.lastBashOutput;
  }

  /** Первая сигнатура ошибки, достигшая порога автопоиска и ещё не искавшаяся. */
  getRepeatedErrorSignature(): string | null {
    return this.observations.getRepeatedErrorSignature();
  }

  /** Счётчик повторов сигнатуры ошибки. */
  getErrorSignatureCount(sig: string): number {
    return this.observations.getErrorSignatureCount(sig);
  }

  /** Помечает сигнатуру как уже искавшуюся. */
  markErrorSearched(sig: string): void {
    this.observations.markErrorSearched(sig);
  }

  /** Снимает метку поиска (разрешает один ретрай). */
  unmarkErrorSearched(sig: string): void {
    this.observations.unmarkErrorSearched(sig);
  }

  /** True, если сигнатура уже искалась. */
  hasErrorSearched(sig: string): boolean {
    return this.observations.hasErrorSearched(sig);
  }

  /** Хинты по описанию шага + состояниям, ещё не покрытым recovery-сообщением. */
  getHints(): string[] {
    return hints(this);
  }

  /** Actionable-хинты по последней ошибке: рантаймы, синтаксис, сеть, шелл-несоответствия. */
  getActionableHints(): string[] {
    return actionableHints(this);
  }

  /** Альтернативный тул при рантайм-краше (ts-node→tsx, jest→vitest, …). Null, если нечего предложить. */
  getToolAlternative(): string | null {
    return toolAlternative(this);
  }

  /** Сообщение о повторяющемся туле (+хинт про process_wait для process_log). */
  getRepetitiveToolMessage(): string {
    return repetitiveToolMessage(this);
  }

  /**
   * Стабильная идентичность варнинга для анти-спам дедупа: тот же ключ каждую
   * итерацию — спам, НОВЫЙ ключ (или длинная пауза) заслуживает re-warn.
   */
  getWarningKey(): string {
    return warningKey(this);
  }

  /** Причина застревания для лога (пусто если здоров). */
  getStuckReason(): string {
    return stuckReason(this);
  }

  /** Recovery-сообщение по первичной причине (пусто если здоров). */
  getRecoveryMessage(): string {
    return recoveryMessage(this);
  }

  /**
   * Классифицирует текущее состояние фейла в стабильный `FailureType`
   * для диагностики/логов. Null если здоров. `iteration` даёт вызывающий
   * (детектор глобальный счётчик цикла не ведёт).
   */
  classifyFailure(iteration = 0): FailureClassification | null {
    return classify(this, iteration);
  }

  /** Компактный маркер `[STUCK: type=..., tool=..., count=..., iteration=N]`. */
  formatFailureDiagnostic(c: FailureClassification): string {
    return formatDiagnostic(c);
  }

  /** Диагностический маркер текущего состояния, или "" если здоров. */
  getStuckDiagnostic(iteration = 0): string {
    return stuckDiagnostic(this, iteration);
  }

  /** Полный сброс всего состояния детектора. */
  reset(): void {
    this.currentStepId = null;
    this.iterationsOnCurrentStep = 0;
    this.toolErrors.clear();
    this.consecutiveFailures = 0;
    this.recentOutcomes = [];
    this.lastFailedTool = "";
    this.lastErrorOutput = "";
    this.recentToolCalls = [];
    this.readOnlyStreak = 0;
    this.fileRewriteCount.clear();
    this.escalationCount = 0;
    this.observations.reset();
  }

  /**
   * Сбрасывает только step-прогресс, храня историю вызовов. Нужно, когда план
   * готов, но цикл продолжается (напр. audit-gate реджектнул готовую задачу):
   * step-stuck варнинги глушатся, а петли повторов всё равно детектятся.
   */
  resetStepProgress(): void {
    this.currentStepId = null;
    this.iterationsOnCurrentStep = 0;
    this.toolErrors.clear();
    this.consecutiveFailures = 0;
    this.recentOutcomes = [];
    this.lastFailedTool = "";
    this.lastErrorOutput = "";
    this.fileRewriteCount.clear();
    this.escalationCount = 0;
    this.observations.reset();
  }
}
