import { PlanCreator, getPlanProgress, type Plan, type StepStatus } from "./planner";

export class PlanTracker {
  private plan: Plan;
  private currentStepIndex: number = 0;

  constructor(plan: Plan) {
    this.plan = plan;
  }

  getPlan(): Plan {
    return this.plan;
  }

  getCurrentStepIndex(): number {
    return this.currentStepIndex;
  }

  getCurrentStep() {
    return this.plan.steps[this.currentStepIndex];
  }

  getStep(id: number) {
    return this.plan.steps.find((s) => s.id === id);
  }

  updateStepStatus(id: number, status: StepStatus): void {
    const step = this.getStep(id);
    if (step) step.status = status;
  }

  addNote(id: number, note: string): void {
    const step = this.getStep(id);
    if (step) step.note = note;
  }

  advance(): boolean {
    // Move past any already-settled (skipped/done) steps without mutating
    // them — overwriting a "skipped" step with "in_progress" deadlocks the
    // plan (the model will never work on a step it deliberately skipped).
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
   * Advance the pointer past any done/skipped steps without mutating their
   * status. Keeps currentStepIndex in sync when the model marks steps done via
   * the `plan update` tool (which never calls advance()). Without this,
   * getCurrentStep() stays on the first step forever and the stuck detector
   * accumulates false-positive "no progress" warnings.
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

  isComplete(): boolean {
    return this.plan.steps.every((s) => s.status === "done" || s.status === "skipped");
  }

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

  toPromptBlock(): string {
    return PlanCreator.toPromptBlock(this.plan, this.currentStepIndex);
  }
}
