/**
 * Состояние детектора застревания: счётчики шагов, тулов и повторов.
 *
 * Вынесено из `stuck-detector.ts` (правило 6): здесь только запись сигналов и
 * предикаты по накопленному состоянию. Сырые наблюдения (bash-прогоны,
 * сигнатуры ошибок) — в `stuck-observations.ts`; тексты — в
 * `stuck-recovery.ts` / `stuck-hints.ts`, они читают поля этого класса
 * (класс внутренний для модуля).
 */
import { canonicalArgsKey } from "../../core/api";
import type { ToolCallRecord } from "./stuck-signals";
import { StuckObservations } from "./stuck-observations";

/** Окно исходов (ok/fail) для оценки «пошли фейлы» (§1.3 аудита). */
const RECENT_OUTCOMES_WINDOW = 6;

/** Детектор застревания: счётчики итераций, ошибок, повторов, петель, эскалаций. */
export class StuckTracker {
  threshold: number;
  errorThreshold: number;
  iterationsOnCurrentStep = 0;
  currentStepId: number | null = null;
  toolErrors: Map<string, number> = new Map();
  currentStepDescription = "";
  recentToolCalls: ToolCallRecord[] = [];
  readonly maxRecentCalls = 10;
  readonly repetitionThreshold = 3;
  consecutiveFailures = 0;
  /**
   * Окно исходов последних вызовов (`ok`/`fail`). Единственный источник правды
   * для «пошли фейлы»: успех чужого тула не отменяет накопленные ошибки
   * (§1.3 аудита) — иначе паттерн `bash✗, read✓, bash✗` вечно молчит.
   */
  recentOutcomes: ("ok" | "fail")[] = [];
  lastFailedTool = "";
  lastErrorOutput = "";
  escalationCount = 0;
  readonly escalationThreshold = 3;
  fileRewriteCount: Map<string, number> = new Map();
  readonly fileRewriteThreshold = 3;
  readonly observations: StuckObservations;

  constructor(threshold = 6, errorThreshold = 3, webSearchThreshold = 5) {
    this.threshold = threshold;
    this.errorThreshold = errorThreshold;
    this.observations = new StuckObservations(webSearchThreshold);
  }

  recordIteration(stepId: number): void {
    if (stepId === this.currentStepId) {
      this.iterationsOnCurrentStep++;
    } else {
      this.resetStepState(stepId);
    }
  }

  /** Отмечает вызов тула (для детекции повторов). */
  recordToolCall(name: string, args: Record<string, unknown>): void {
    const argsKey = canonicalArgsKey(name, args);
    this.recentToolCalls.push({ name, argsKey });
    if (this.recentToolCalls.length > this.maxRecentCalls) {
      this.recentToolCalls.shift();
    }
  }

  /** Отмечает ошибку тула (счётчики + сигнатура для автопоиска). */
  recordToolError(toolName: string, output?: string): void {
    this.toolErrors.set(toolName, (this.toolErrors.get(toolName) || 0) + 1);
    this.consecutiveFailures++;
    this.pushOutcome("fail");
    this.lastFailedTool = toolName;
    if (output) this.lastErrorOutput = output;
    this.observations.recordErrorSignature(toolName, output);
  }

  /** Последний текст ошибки. */
  getLastErrorOutput(): string {
    return this.lastErrorOutput;
  }

  /** Последний упавший тул. */
  getLastFailedTool(): string {
    return this.lastFailedTool;
  }

  /** Итераций на текущем шаге. */
  getIterationsOnCurrentStep(): number {
    return this.iterationsOnCurrentStep;
  }

  /** Отмечает успешный тул: сброс фейлов, затухание per-tool счётчиков и итераций. */
  recordToolSuccess(toolName?: string): void {
    this.pushOutcome("ok");
    // NOTE: escalationCount осознанно НЕ сбрасываем. Один тривиальный успех
    // (напр. один read_file) раньше его чистил, и shouldEscalate() на флейлящей
    // сессии почти не достигался — в ущерб анти-гейминг свойству, которое
    // resetStepState() явно хранит.
    // Затухание per-tool счётчиков: снимается одна запись ТОЛЬКО того тула,
    // который отработал. Раньше успех любого тула гасил счётчик падавшего —
    // паттерн `bash✗, read✓, bash✗` не достигал порога (§1.3 аудита).
    if (toolName) {
      const count = this.toolErrors.get(toolName);
      if (count !== undefined) {
        if (count <= 1) this.toolErrors.delete(toolName);
        else this.toolErrors.set(toolName, count - 1);
      }
    } else {
      // Имя тула не передано (legacy-вызов): затухаем все счётчики по одной
      // записи — как раньше, чтобы старый варнинг не жил вечно.
      for (const [tool, count] of this.toolErrors) {
        if (count <= 1) this.toolErrors.delete(tool);
        else this.toolErrors.set(tool, count - 1);
      }
    }
    // Затухание счётчика итераций на продуктивных вызовах: чтение новых файлов,
    // записи, правки — всё прогресс. Защита от ложных stuck-варнингов при
    // легитимной разведке файлов (напр. чтение 12 файлов в analytic-шаге).
    if (this.iterationsOnCurrentStep > 0) {
      this.iterationsOnCurrentStep = Math.max(0, this.iterationsOnCurrentStep - 1);
    }
  }

  /** Кладёт исход в окно и обрезает его по длине. */
  private pushOutcome(outcome: "ok" | "fail"): void {
    this.recentOutcomes.push(outcome);
    if (this.recentOutcomes.length > RECENT_OUTCOMES_WINDOW) this.recentOutcomes.shift();
  }

  /** Фейлы в окне последних вызовов (окно, а не счётчик с обнулением). */
  private failuresInWindow(): number {
    let failures = 0;
    for (const outcome of this.recentOutcomes) if (outcome === "fail") failures++;
    return failures;
  }

  /** Ставит текущий шаг (сброс per-step состояния при смене). */
  setCurrentStep(stepId: number, description: string): void {
    if (stepId !== this.currentStepId) {
      this.resetStepState(stepId);
    }
    this.currentStepDescription = description;
  }

  /** True, если итераций на шаге больше порога. */
  isStuck(): boolean {
    return this.iterationsOnCurrentStep > this.threshold;
  }

  /** Счётчик ошибок конкретного тула (0 — ошибок не было). */
  getToolErrorCount(toolName: string): number {
    return this.toolErrors.get(toolName) ?? 0;
  }

  /** True, если тул (или любой) ошибался ≥ порога. */
  hasRepetitiveErrors(toolName?: string): boolean {
    if (toolName) {
      return (this.toolErrors.get(toolName) || 0) >= this.errorThreshold;
    }
    return Array.from(this.toolErrors.values()).some((c) => c >= this.errorThreshold);
  }

  /** True при повторяющихся вызовах: подряд идентичных или перемежающихся (A,B,A,B,A). */
  hasRepetitiveToolCalls(): boolean {
    if (this.recentToolCalls.length < this.repetitionThreshold) return false;
    const last = this.recentToolCalls[this.recentToolCalls.length - 1];
    // Проверка подряд идентичных (исходная логика)
    let consecutiveCount = 1;
    for (let i = this.recentToolCalls.length - 2; i >= 0; i--) {
      // argsKey = `name::canonicalArgs` — имя уже внутри, сравниваем ключ.
      if (this.recentToolCalls[i].argsKey === last.argsKey) {
        consecutiveCount++;
      } else {
        break;
      }
    }
    if (consecutiveCount >= this.repetitionThreshold) return true;
    // Плюс перемежающиеся паттерны (A, B, A, B, A): считаем каждую связку
    // тул+args в окне и флагуем при ≥ порога
    const counts = new Map<string, number>();
    for (const call of this.recentToolCalls) {
      counts.set(call.argsKey, (counts.get(call.argsKey) || 0) + 1);
    }
    for (const count of counts.values()) {
      if (count >= this.repetitionThreshold) return true;
    }
    return false;
  }

  /** True, если в окне последних вызовов хватает фейлов (окно, а не streak). */
  hasConsecutiveFailures(): boolean {
    return this.failuresInWindow() >= this.errorThreshold;
  }

  /** Число фейлов в окне последних вызовов. */
  getConsecutiveFailuresCount(): number {
    return this.failuresInWindow();
  }

  /** Отмечает эскалацию (счётчик для shouldEscalate). */
  recordEscalation(): void {
    this.escalationCount++;
  }

  /** True, если эскалаций набралось на порог. */
  shouldEscalate(): boolean {
    return this.escalationCount >= this.escalationThreshold;
  }

  /** Сбрасывает счётчик эскалаций. */
  resetEscalation(): void {
    this.escalationCount = 0;
  }

  /** Число эскалаций. */
  getEscalationCount(): number {
    return this.escalationCount;
  }

  /** Отмечает перезапись файла (счётчик для детекции петли). */
  recordFileRewrite(filePath: string): void {
    const count = (this.fileRewriteCount.get(filePath) || 0) + 1;
    this.fileRewriteCount.set(filePath, count);
  }

  /** Число перезаписей файла. */
  getFileRewriteCount(filePath: string): number {
    return this.fileRewriteCount.get(filePath) || 0;
  }

  /** True, если какой-то файл переписывается ≥ порога. */
  hasExcessiveRewrites(): boolean {
    return Array.from(this.fileRewriteCount.values()).some((c) => c >= this.fileRewriteThreshold);
  }

  /** Файл с избыточными перезаписями, или null. */
  getExcessiveRewriteFile(): string | null {
    for (const [file, count] of this.fileRewriteCount) {
      if (count >= this.fileRewriteThreshold) return file;
    }
    return null;
  }

  /**
   * Сбрасывает всё per-step состояние при переходе на новый шаг. Не даёт
   * ошибкам и повторам одного шага протекать в следующий (ложные
   * stuck/recovery на первой итерации нового шага).
   */
  protected resetStepState(stepId: number): void {
    this.currentStepId = stepId;
    this.iterationsOnCurrentStep = 1;
    this.toolErrors.clear();
    this.consecutiveFailures = 0;
    this.recentOutcomes = [];
    this.lastFailedTool = "";
    this.lastErrorOutput = "";
    this.recentToolCalls = [];
    this.fileRewriteCount.clear();
    this.observations.reset();
    // escalationCount храним — иначе агент "геймит" детекцию, маркируя шаг
    // done и переходя к следующему
  }
}
