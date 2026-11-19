// Обработчик тула `todo` (add/done/list подзадач шага) — вынесен из
// `plan-tool.ts` (правило ≤300).
import { t } from "../../i18n/index";
import type { Subtask } from "./planner";
import type { ToolResult } from "../../tools/types";
import type { PlanToolDeps } from "./plan-tool";

/**
 * Маркит подзадачи done по числовым id (предпочтительно) или точному тексту
 * (фолбэк). Возвращает число отмеченных, или строку ошибки если ничего не сошлось.
 */
function markTodoDone(
  subs: Subtask[],
  ids: number[],
  items: string[],
): { marked: number } | { error: string } {
  let marked = 0;
  if (ids.length > 0) {
    for (const id of ids) {
      const sub = subs.find((s) => !s.done && s.id === id);
      if (sub) {
        sub.done = true;
        marked++;
      }
    }
    if (marked === 0) {
      return { error: t("todo.subtask_id_not_found", { ids: ids.join(", ") }) };
    }
    return { marked };
  }
  for (const item of items) {
    const sub = subs.find((s) => !s.done && s.text.toLowerCase() === item.toLowerCase());
    if (sub) {
      sub.done = true;
      marked++;
    }
  }
  if (marked === 0) {
    return { error: t("todo.subtask_not_found", { items: items.join(", ") }) };
  }
  return { marked };
}

/** Тул `todo`: add/done/list подзадач текущего шага. */
export async function runTodo(
  deps: PlanToolDeps,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (!deps.trackerRef.current) {
    return { success: false, output: deps.noActivePlanMessage() };
  }
  const tracker = deps.trackerRef.current;
  const action = String(args.action);
  const currentStep = tracker.getCurrentStep();
  if (!currentStep) {
    return { success: false, output: t("plan.step_not_found") };
  }
  if (action === "add" && Array.isArray(args.items)) {
    const items = args.items.map(String);
    const existing = currentStep.subtasks ?? [];
    let nextId = existing.reduce((m, s) => Math.max(m, s.id), 0) + 1;
    for (const item of items) {
      existing.push({ id: nextId++, text: item, done: false });
    }
    currentStep.subtasks = existing;
    deps.persistPlan(tracker.getPlan());
    const display = tracker.toPromptBlock();
    const addedIds = existing.slice(-items.length).map((s) => s.id);
    const addedOutput =
      t("todo.added", { count: String(items.length), items: items.join(", ") }) +
      ` (ids: ${addedIds.join(", ")})`;
    return { success: true, output: addedOutput, display };
  }
  if (action === "done") {
    const ids = Array.isArray(args.ids) ? args.ids.map(Number).filter((n) => !Number.isNaN(n)) : [];
    const items = Array.isArray(args.items) ? args.items.map(String) : [];
    if (ids.length === 0 && items.length === 0) {
      return { success: false, output: t("todo.no_items") };
    }
    const subs = currentStep.subtasks ?? [];
    const done = markTodoDone(subs, ids, items);
    if ("error" in done) {
      return { success: false, output: done.error };
    }
    const marked = done.marked;
    currentStep.subtasks = subs;
    deps.persistPlan(tracker.getPlan());
    const doneCount = subs.filter((s) => s.done).length;
    const display = tracker.toPromptBlock();
    // Отметка подзадачи done НЕ должна автозавершать шаг плана: шаг done,
    // только когда модель подтвердит весь шаг через plan update.
    let output = t("todo.marked_done", { count: String(marked) });
    output += ` (${doneCount}/${subs.length})`;
    if (doneCount === subs.length) {
      output += `\n${t("plan.subtasks_done", { stepId: String(currentStep.id) })}`;
    }
    return { success: true, output, display };
  }
  if (action === "list") {
    const subs = currentStep.subtasks ?? [];
    const lines = subs.length
      ? subs.map((s) => `[${s.id}] ${s.done ? "[x]" : "[ ]"} ${s.text}`)
      : [t("plan.no_subtasks")];
    return {
      success: true,
      output: `${t("plan.step_label", { stepId: String(currentStep.id), description: currentStep.description })}\n${lines.join("\n")}`,
    };
  }
  return { success: false, output: t("todo.unknown_action", { action }) };
}
