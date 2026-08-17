import { PlanCreator, type Plan, type StepStatus } from "./planner";

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
    if (this.currentStepIndex < this.plan.steps.length - 1) {
      this.currentStepIndex++;
      this.plan.steps[this.currentStepIndex].status = "in_progress";
      return true;
    }
    return false;
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
    const done = this.plan.steps.filter((s) => s.status === "done").length;
    const total = this.plan.steps.length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const barWidth = 10;
    const filled = Math.round((done / total) * barWidth);
    const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
    return `[${this.plan.id}] ${this.plan.title}  ${done}/${total}  ${bar}  ${pct}%`;
  }

  toPromptBlock(): string {
    return PlanCreator.toPromptBlock(this.plan, this.currentStepIndex);
  }
}
