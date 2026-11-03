// Действия жизненного цикла плана: switch/abort/delete/purge. Меняют
// store + trackerRef, не валидируют шаги и не собирают план (это в plan-actions).
import type { ToolResult, ToolContext } from "../../tools/types";
import { t } from "../../i18n/index";
import type { PlanToolDeps } from "./plan-tool";
import type { PlanAction } from "./plan-actions";

/** Переключает активный план; повторный switch на активном — no-op. */
export function actionSwitch(deps: PlanToolDeps, _ctx: ToolContext, args: Record<string, unknown>): ToolResult {
  const planId = String(args.id || "");
  if (!planId) {
    return { success: false, output: t("plan.switch_no_id") };
  }
  const found = deps.store.find(planId);
  if (!found) {
    return {
      success: false,
      output: t("plan.not_found", { id: planId }),
    };
  }
  // Переключение на уже активный план — no-op, не дубль (было: switch на
  // активном сохранял active.json и переставлял тот же план, плодя копии).
  if (found.status === "active") {
    return {
      success: true,
      output: t("plan.already_active", {
        id: found.plan.id,
        title: found.plan.title,
      }),
      display: deps.trackerRef.current?.toPromptBlock(),
    };
  }
  deps.preserveActive();
  if (found.status === "draft") {
    deps.store.removeDraft(found.plan.id);
  } else if (found.status === "archived") {
    deps.store.removeArchived(found.plan.id);
  }
  deps.setPlan(found.plan);
  // Display из трекера (setPlan подтягивает указатель мимо done/skipped),
  // чтобы "current: step N" указывал на первый пендинг шаг переключённого
  // плана, а не вечно на шаг 1.
  const display = deps.trackerRef.current?.toPromptBlock();
  return {
    success: true,
    output: t("plan.switched", {
      id: found.plan.id,
      title: found.plan.title,
    }),
    display,
  };
}

/** Абортит план по id или активный; архивные терминальны. */
export function actionAbort(deps: PlanToolDeps, _ctx: ToolContext, args: Record<string, unknown>): ToolResult {
  const planId = args.id ? String(args.id) : "";
  if (planId) {
    // Аборт КОНКРЕТНОГО плана (не активного). Черновик → архив, активный →
    // архив + очистка трекера. Архивные уже терминальны — абортить нечего.
    const found = deps.store.find(planId);
    if (!found) {
      return {
        success: false,
        output: t("plan.not_found", { id: planId }),
      };
    }
    if (found.status === "archived") {
      return {
        success: false,
        output: t("plan.already_archived", { id: planId }),
      };
    }
    deps.store.archivePlan(found.plan); // был активным — active тоже чистится
    if (found.status === "active") {
      deps.trackerRef.current = null;
      deps.clearCompleted();
    }
    return {
      success: true,
      output: t("plan.aborted_id", { id: found.plan.id }),
    };
  }
  const tracker = deps.trackerRef.current;
  if (!tracker) {
    // Аборт без активного плана и без id — раньше возвращал success:true, и
    // модель верила, что абортнула несуществующий план (было: 3× abort на
    // пустом списке).
    return { success: false, output: deps.noActivePlanMessage() };
  }
  deps.store.archivePlan(tracker.getPlan());
  deps.trackerRef.current = null;
  deps.store.clearActive();
  deps.clearCompleted();
  return { success: true, output: t("plan.aborted") };
}

/** Удаляет план по id (активный чистит и трекер). */
export function actionDelete(deps: PlanToolDeps, _ctx: ToolContext, args: Record<string, unknown>): ToolResult {
  const planId = String(args.id || "");
  if (!planId) {
    return { success: false, output: t("plan.delete_no_id") };
  }
  const deleted = deps.store.deletePlan(planId);
  if (!deleted) {
    return {
      success: false,
      output: t("plan.not_found", { id: planId }),
    };
  }
  if (deleted === "active") {
    deps.trackerRef.current = null;
    deps.clearCompleted();
  }
  return {
    success: true,
    output: t("plan.deleted", { id: planId }),
  };
}

/** Удаляет ВСЕ планы (активный, черновики, архив). */
export function actionPurge(deps: PlanToolDeps): ToolResult {
  const count = deps.store.purgeAll();
  deps.trackerRef.current = null;
  deps.clearCompleted();
  return {
    success: true,
    output: t("plan.purged", { count: String(count) }),
  };
}

/** Словарь действий жизненного цикла. */
export const PLAN_LIFECYCLE_ACTIONS: Record<string, PlanAction> = {
  switch: actionSwitch,
  abort: actionAbort,
  delete: actionDelete,
  purge: actionPurge,
};
