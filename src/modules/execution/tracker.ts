// Трекер плана: указатель текущего шага, статусы, прогресс-строка.
// Двигает указатель мимо уже settled (skipped/done) шагов, не мутируя их —
// перезапись "skipped" в "in_progress" дедлочит план (модель не возьмётся за
// шаг, который осознанно пропустила).
import { PlanCreator, getPlanProgress, type Plan, type StepStatus } from "./planner";

/** Трекер плана: указатель, статусы шагов, прогресс. */
export class PlanTracker {
  private plan: Plan;
  private currentStepIndex: number = 0;

  constructor(plan: Plan) {
    this.plan = plan;
  }

  /** План целиком. */
  getPlan(): Plan {
    return this.plan;
  }

  /** Индекс текущего шага. */
  getCurrentStepIndex(): number {
    return this.currentStepIndex;
  }

  /** Текущий шаг (по указателю). */
  getCurrentStep() {
    return this.plan.steps[this.currentStepIndex];
  }

  /** Шаг по id. */
  getStep(id: number) {
    return this.plan.steps.find((s) => s.id === id);
  }

  /** Ставит статус шагу. */
  updateStepStatus(id: number, status: StepStatus): void {
    const step = this.getStep(id);
    if (step) step.status = status;
  }

  /** Добавляет заметку к шагу. */
  addNote(id: number, note: string): void {
    const step = this.getStep(id);
    if (step) step.note = note;
  }

  /**
   * Двигает указатель к следующему незакрытому шагу (мимо done/skipped без
   * мутаций). False, если шагов не осталось.
   */
  advance(): boolean {
    let idx = this.currentStepIndex + 1;
    while (
      idx < this.plan.steps.length &&
      (this.plan.steps[idx].status === "skipped" || this.plan.steps[idx].status === "done")
    ) {
      idx++;
    }
    if (idx >= this.plan.steps.length) return false;
    this.currentStepIndex = idx;
    if (this.plan.steps[idx].status === "pending") {
      this.plan.steps[idx].status = "in_progress";
    }
    return true;
  }

  /**
   * Подтягивает указатель мимо done/skipped шагов без смены статусов.
   * Синхронизирует currentStepIndex, когда модель маркит шаги через тул
   * `plan update` (он advance() не зовёт). Без этого getCurrentStep() вечно
   * стоит на первом шаге и stuck-детектор копит ложные "no progress".
   */
  syncCurrentStep(): void {
    while (
      this.currentStepIndex < this.plan.steps.length - 1 &&
      (this.plan.steps[this.currentStepIndex].status === "done" ||
        this.plan.steps[this.currentStepIndex].status === "skipped")
    ) {
      this.currentStepIndex++;
    }
  }

  /** True, если все шаги done/skipped. */
  isComplete(): boolean {
    return this.plan.steps.every((s) => s.status === "done" || s.status === "skipped");
  }

  /** Строка прогресса: `[id] title settled/total (skipped) bar pct`. */
  getProgressString(): string {
    const p = getPlanProgress(this.plan);
    const total = p.total;
    const settled = p.settled;
    const pct = total > 0 ? Math.round((settled / total) * 100) : 0;
    const barWidth = 10;
    const filled = Math.round((settled / total) * barWidth);
    const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
    const skippedPart = p.skipped > 0 ? ` (${p.skipped} skipped)` : "";
    return `[${this.plan.id}] ${this.plan.title}  ${settled}/${total}${skippedPart}  ${bar}  ${pct}%`;
  }

  /** Промпт-блок плана с текущей позиции указателя. */
  toPromptBlock(): string {
    return PlanCreator.toPromptBlock(this.plan, this.currentStepIndex);
  }
}
