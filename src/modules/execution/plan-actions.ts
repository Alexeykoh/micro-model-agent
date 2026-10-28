// Действия тула plan: по одной функции на action + словарь-диспетчер.
import type { ToolResult, ToolContext } from "../../tools/types";
import { t } from "../../i18n/index";
import { PlanCreator } from "./planner";
import { checkPlanCoverage } from "./plan-coverage";
import type { PlanToolDeps } from "./plan-tool";

/**
 * Действие плана: (deps, ctx, args) → ToolResult. По одной функции на action,
 * диспетчер — словарь PLAN_ACTIONS.
 */
export type PlanAction = (
  deps: PlanToolDeps,
  ctx: ToolContext,
  args: Record<string, unknown>,
) => Promise<ToolResult> | ToolResult;

function actionList(deps: PlanToolDeps): ToolResult {
  const metas = deps.store.listAll();
  if (metas.length === 0) {
    return { success: true, output: t("plan.list_empty") };
  }
  const lines = metas.map((m) => {
    const icon = m.status === "active" ? "[*]" : m.status === "draft" ? "[ ]" : "[-]";
    const namePart = m.name ? ` (${m.name})` : "";
    return `${icon} ${m.id}${namePart} — ${m.title}  ${m.doneCount}/${m.stepCount}`;
  });
  lines.push("");
  lines.push(t("plan.list_legend"));
  return {
    success: true,
    output: `${t("plan.list_header")}\n${lines.join("\n")}`,
  };
}

function actionSwitch(deps: PlanToolDeps, _ctx: ToolContext, args: Record<string, unknown>): ToolResult {
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

function actionRePlan(deps: PlanToolDeps, _ctx: ToolContext, args: Record<string, unknown>): ToolResult {
  if (!deps.trackerRef.current) {
    return { success: false, output: deps.noActivePlanMessage() };
  }
  const newSteps = Array.isArray(args.steps) ? args.steps.map(String) : [];
  if (newSteps.length === 0) {
    return { success: false, output: t("plan.replan_no_steps") };
  }
  const tracker = deps.trackerRef.current;
  const oldPlan = tracker.getPlan();
  const checked = deps.parseChecks(args, newSteps);
  if (checked.error) {
    return { success: false, output: checked.error };
  }
  const replanned = PlanCreator.replan(
    oldPlan,
    newSteps,
    args.title ? String(args.title) : undefined,
    checked.checks ?? [],
  );
  const keptCount = replanned.steps.length - newSteps.length;
  deps.setPlan(replanned);
  const display = deps.trackerRef.current?.toPromptBlock();
  return {
    success: true,
    output: t("plan.replanned", {
      kept: String(keptCount),
      steps: String(newSteps.length),
    }),
    display,
  };
}

function actionCreate(deps: PlanToolDeps, ctx: ToolContext, args: Record<string, unknown>): ToolResult {
  const title = String(args.title || "Task Plan");
  const steps = Array.isArray(args.steps) ? args.steps.map(String) : [];
  if (steps.length === 0) {
    return { success: false, output: t("plan.no_steps") };
  }
  const parsed = deps.parseKinds(args, steps);
  if (parsed.error) {
    return { success: false, output: parsed.error };
  }
  const checked = deps.parseChecks(args, steps);
  if (checked.error) {
    return { success: false, output: checked.error };
  }

  // Покрытие валидируем ДО любой мутации состояния: заблокированный create не
  // оставит полусозданный активный план (следующий create споткнулся бы об
  // active_in_progress на плане, успех которого модель не видела).
  const taskText = deps.getTaskText(ctx);
  if (taskText) {
    const { missing } = checkPlanCoverage(taskText, steps);
    if (missing.length > 0) {
      // Жёсткий блок (не варнинг): 9B-модель читает "success:true + ⚠️" как
      // успех и 5+ итераций работает по мусору, пока deliverable-gate не
      // остановит. Стопорим на создании со списком файлов.
      return {
        success: false,
        output: t("plan.coverage_blocked", {
          missing: missing.join(", "),
        }),
      };
    }
  }

  // Активный план с прогрессом молча не выбрасываем (было: ses_msvuao0h —
  // сразу после компакции модель снова звала `plan create`, сливая план 1/6 в
  // черновики и стартуя с нуля). Активный план С прогрессом блокирует создание,
  // пока модель осознанно его не абортнит. Свежий план (все шаги pending)
  // заменять безопасно — модель могла передумать насчёт подхода.
  const existing = deps.trackerRef.current;
  if (existing) {
    const activePlan = existing.getPlan();
    const progressed = activePlan.steps.some(
      (s) => s.status === "done" || s.status === "failed" || s.status === "skipped",
    );
    if (progressed) {
      const done = activePlan.steps.filter((s) => s.status === "done").length;
      return {
        success: false,
        output: t("plan.active_in_progress", {
          id: activePlan.id,
          done: String(done),
          total: String(activePlan.steps.length),
          current: String(existing.getCurrentStepIndex() + 1),
        }),
      };
    }
  }

  deps.preserveActive();
  const plan = PlanCreator.createPlan(title, steps, deps.baseDir, parsed.kinds ?? [], checked.checks ?? []);
  deps.setPlan(plan);
  const display = PlanCreator.toPromptBlock(plan, 0);
  let output = t("plan.created", {
    title,
    steps: String(steps.length),
  });
  // Модель иногда передаёт id, ожидая план под ним (было: id
  // "plan_error_check_e07pb2" проигнорирован, появился новый id). Объясняем
  // явно, чтобы не искала план по неверному id.
  if (args.id) {
    output += `\n${t("plan.id_ignored")}`;
  }
  if (existing) {
    output += `\n${t("plan.existing_fresh")}`;
  }
  return {
    success: true,
    output,
    display,
  };
}

function actionShow(deps: PlanToolDeps, _ctx: ToolContext, args: Record<string, unknown>): ToolResult {
  const planId = args.id ? String(args.id) : "";
  if (planId && planId !== deps.trackerRef.current?.getPlan()?.id) {
    // Показываем КОНКРЕТНЫЙ план (активный, черновик, архив), а не игнорируем
    // id вечным выводом активного (было: модель трижды просила архивный план
    // и каждый раз получала активный).
    const found = deps.store.find(planId);
    if (!found) {
      return {
        success: false,
        output: t("plan.not_found", { id: planId }),
      };
    }
    const display = PlanCreator.toPromptBlock(found.plan, 0);
    return {
      success: true,
      output: `${t("plan.show_header")}\n${display}`,
      display,
    };
  }
  if (!deps.trackerRef.current) {
    return { success: false, output: deps.noActivePlanMessage() };
  }
  const display = deps.trackerRef.current.toPromptBlock();
  return {
    success: true,
    output: `${t("plan.show_header")}\n${display}`,
    display,
  };
}

function actionUpdate(deps: PlanToolDeps, ctx: ToolContext, args: Record<string, unknown>): ToolResult | Promise<ToolResult> {
  // Обновление конкретного шага.
  if (args.step && deps.trackerRef.current) {
    return updatePlanStep(deps, ctx, args);
  }
  // Массовая пересборка плана через update запрещена: она молча меняет
  // состав/название плана (churn) и теряет статусы. Модель должна осознанно
  // выбрать `re-plan` (сохраняет завершённые шаги) или `create` (новый план).
  if (Array.isArray(args.steps) && args.steps.length > 0 && !args.step) {
    return { success: false, output: t("plan.bulk_update_rejected") };
  }
  // Ни шага, ни шагов — тот же фолбэк, что был в хвосте монолита.
  return noActiveOrUnknown(deps, args, "update");
}


import { updatePlanStep } from "./step-update";

function actionAbort(deps: PlanToolDeps, _ctx: ToolContext, args: Record<string, unknown>): ToolResult {
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
function actionDelete(deps: PlanToolDeps, _ctx: ToolContext, args: Record<string, unknown>): ToolResult {
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
function actionPurge(deps: PlanToolDeps): ToolResult {
  const count = deps.store.purgeAll();
  deps.trackerRef.current = null;
  deps.clearCompleted();
  return {
    success: true,
    output: t("plan.purged", { count: String(count) }),
  };
}

/** Фолбэк из хвоста монолита: readonly-план по id или "нет активного плана". */
function noActiveOrUnknown(
  deps: PlanToolDeps,
  args: Record<string, unknown>,
  action: string,
): ToolResult {
  if (!deps.trackerRef.current) {
    // Update с id на черновик/архив: говорим, что план read-only, а не голое
    // "No active plan" (было: 10+ итераций re-update архивного плана с тем же
    // бесполезным ответом).
    if (args.id) {
      const found = deps.store.find(String(args.id));
      if (found && found.status !== "active") {
        return {
          success: false,
          output: t("plan.readonly", { id: found.plan.id, status: found.status }),
        };
      }
    }
    return { success: false, output: deps.noActivePlanMessage() };
  }
  return {
    success: false,
    output: t("plan.unknown_action", { action }),
  };
}

/** Словарь действий плана: имя → обработчик. */
export const PLAN_ACTIONS: Record<string, PlanAction> = {
  list: actionList,
  switch: actionSwitch,
  "re-plan": actionRePlan,
  create: actionCreate,
  show: actionShow,
  update: actionUpdate,
  abort: actionAbort,
  delete: actionDelete,
  purge: actionPurge,
};

/** Диспетчер: возвращает обработчик действия или null для неизвестного action. */
export function dispatchPlanAction(
  action: string,
  deps: PlanToolDeps,
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> | ToolResult | null {
  const fn = PLAN_ACTIONS[action];
  if (!fn) return null;
  return fn(deps, ctx, args);
}
