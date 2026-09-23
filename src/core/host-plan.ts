import type { HostStateSnapshot, PlanStepStatus } from "./host";
import type { Plan, StepStatus } from "../modules/execution/planner";

/** Minimal plan shape the host UI consumes. Kept separate from the execution
 *  module's `Plan` so `planSnapshotFromModule` stays a pure projection that is
 *  trivially testable without booting the execution module. */
export interface ActivePlanLike {
  steps: { text: string; status: PlanStepStatus }[];
  currentIndex: number;
}

/** Pure projection of an ExecutionModule plan into a HostStateSnapshot plan. */
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
 * Execution plans carry a fifth status (`skipped`) and no `currentIndex`. Map
 * them onto the host contract: a skipped step is settled, so it reads as done,
 * and the current index is the first step that is neither done nor skipped.
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

/** Adapt the execution module's real `Plan` into the snapshot input shape. */
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
