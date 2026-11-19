// Движок пайплайнов: топологический порядок шагов, готовность, статусы.
import type { PipelineStep } from "./parser";
import { t } from "../../i18n/index";

/** Статус шага пайплайна. */
export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

/** Движок пайплайна: порядок обхода зависимостей и учёт статусов шагов. */
export class PipelineEngine {
  private stepStatus: Map<string, StepStatus> = new Map();

  /**
   * Топологически сортирует шаги по `depends_on`. Бросает при цикле.
   * Возвращает id в порядке выполнения.
   */
  resolveDependencies(steps: PipelineStep[]): string[] {
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const order: string[] = [];

    function visit(stepId: string, stepMap: Map<string, PipelineStep>): void {
      if (inStack.has(stepId)) throw new Error(t("pipeline.circular", { stepId }));
      if (visited.has(stepId)) return;

      inStack.add(stepId);
      const step = stepMap.get(stepId);
      if (step?.depends_on) {
        for (const dep of step.depends_on) {
          visit(dep, stepMap);
        }
      }
      inStack.delete(stepId);
      visited.add(stepId);
      order.push(stepId);
    }

    const stepMap = new Map(steps.map((s) => [s.id, s]));
    for (const step of steps) {
      if (!visited.has(step.id)) {
        visit(step.id, stepMap);
      }
    }

    return order;
  }

  /** Шаги, готовые к запуску: не завершены, не в работе/провале, зависимости закрыты. */
  getReadySteps(steps: PipelineStep[], completed: Set<string>): PipelineStep[] {
    return steps.filter((s) => {
      if (completed.has(s.id)) return false;
      if (this.stepStatus.get(s.id) === "running") return false;
      if (this.stepStatus.get(s.id) === "failed") return false;
      if (!s.depends_on || s.depends_on.length === 0) return true;
      return s.depends_on.every((d) => completed.has(d));
    });
  }

  /** Ставит статус шага. */
  setStepStatus(stepId: string, status: StepStatus): void {
    this.stepStatus.set(stepId, status);
  }

  /** Статус шага; неизвестному — `pending`. */
  getStepStatus(stepId: string): StepStatus {
    return this.stepStatus.get(stepId) || "pending";
  }

  /** True, когда все шаги `done` или `skipped`. */
  isComplete(stepIds: string[]): boolean {
    return stepIds.every((id) => {
      const s = this.stepStatus.get(id);
      return s === "done" || s === "skipped";
    });
  }

  /** Сбрасывает все статусы (перезапуск пайплайна). */
  reset(): void {
    this.stepStatus.clear();
  }
}
