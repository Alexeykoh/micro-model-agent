import type { Plan, PlanStep, StepKind } from "./planner";

/**
 * Авто-переключение шага плана на kind="delete".
 *
 * Два независимых механизма писали `step.kind = "delete"` и сами персистили
 * план:
 * - plan-tool: шаг помечается done, а все его дативные файлы подтверждённо
 *   удалены (deliverable gate);
 * - execution-plugin: модель вызвала delete_file, и удалённый путь
 *   пересекается с описанием шага.
 *
 * Здесь — единая точка, чтобы инвариант «сменить kind и сохранить план»
 * жил в одном месте и не расходился между авторами.
 *
 * @returns true, если шаг был переключён (и план сохранён); false, если
 * kind уже был "delete" — ничего не менялось.
 */
export function switchStepKind(
  plan: Plan,
  step: PlanStep,
  kind: StepKind,
  save: (plan: Plan) => void,
): boolean {
  if (step.kind === kind) return false;
  step.kind = kind;
  save(plan);
  return true;
}

export function switchStepToDelete(
  plan: Plan,
  step: PlanStep,
  save: (plan: Plan) => void,
): boolean {
  return switchStepKind(plan, step, "delete", save);
}

export function switchStepToCreate(
  plan: Plan,
  step: PlanStep,
  save: (plan: Plan) => void,
): boolean {
  return switchStepKind(plan, step, "create", save);
}