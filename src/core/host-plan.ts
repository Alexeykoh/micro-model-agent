/** Проекция плана исполнения в снапшот хоста для UI. */
import type { HostStateSnapshot, PlanStepStatus } from "./host";
import type { Plan, StepStatus } from "../modules/execution/planner";

/**
 * Минимальная форма плана для UI хоста. Отдельно от `Plan` модуля исполнения,
 * чтобы `planSnapshotFromModule` оставалась чистой проекцией без бутстрапа модуля.
 */
export interface ActivePlanLike {
  steps: { text: string; status: PlanStepStatus }[];
  currentIndex: number;
}

/**
 * Чистая проекция плана модуля исполнения в план снапшота хоста.
 * @param plan план в форме ActivePlanLike; @returns план снапшота либо null.
 */
export function planSnapshotFromModule(
  plan: ActivePlanLike | null | undefined,
): HostStateSnapshot["plan"] {
  if (!plan) return null;
  return {
    steps: plan.steps.map((s) => ({ text: s.text, status: s.status })),
    currentIndex: plan.currentIndex,
  };
}

/**
 * Планы несут пятый статус (`skipped`) без `currentIndex`. Маппим на контракт
 * хоста: skipped — settled, читается как done; текущий индекс — первый шаг
 * не в done/skipped.
 */
function toPlanStepStatus(status: StepStatus): PlanStepStatus {
  switch (status) {
    case "skipped":
      return "done";
    case "pending":
    case "in_progress":
    case "done":
    case "failed":
      return status;
  }
}

/**
 * Адаптирует реальный `Plan` модуля исполнения под вход снапшота.
 * @param plan план исполнения; @returns ActivePlanLike либо null.
 */
export function adaptActivePlan(plan: Plan | null | undefined): ActivePlanLike | null {
  if (!plan) return null;
  return {
    steps: plan.steps.map((s) => ({
      text: s.description,
      status: toPlanStepStatus(s.status),
    })),
    currentIndex: plan.steps.findIndex(
      (s) => s.status !== "done" && s.status !== "skipped",
    ),
  };
}
