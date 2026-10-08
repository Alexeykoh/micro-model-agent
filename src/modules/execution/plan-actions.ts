// Действия тула plan: по одной функции на action + словарь-диспетчер.
import type { ToolResult, ToolContext } from "../../tools/types";
import { t } from "../../i18n/index";
import { PlanCreator, getPlanProgress, type PlanStep } from "./planner";
import type { PlanTracker } from "./tracker";
import { parseCheck } from "./plan-checks";
import { stepTypecheckGate } from "./execution-plugin";
import { switchStepToCreate, switchStepToDelete } from "./plan-steps";
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

/**
 * Статусы, которые `plan update` вправе ставить. Остальное (произвольный текст
 * модели, `pending`/`in_progress`) реджектится: неизвестный статус не закроет
 * `isComplete()`, план крутился бы вечно, а мусор персистился бы в
 * `.mma/plans/active.json`.
 */
const STEP_UPDATE_STATUSES = ["done", "failed", "skipped"] as const;
type StepUpdateStatus = (typeof STEP_UPDATE_STATUSES)[number];

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

/**
 * Выводит kind create/delete шага из СДЕЛАННОГО агентом (не заявленного).
 * Прямо: create-шаг, чьи файлы пропали И трекнуты удалёнными → флип в delete.
 * Обратно: delete-шаг, чьи файлы ни существуют, ни удалялись → флип в create
 * и блок (пустой pass ничего бы не сертифицировал; файлы, снесённые юзером
 * снаружи — известный tradeoff: скипай шаг). Обратный случай возвращает
 * блокирующий ToolResult, иначе null.
 */
function autoResolveStepKind(
  deps: PlanToolDeps,
  tracker: PlanTracker,
  target: PlanStep,
  stepId: number,
): ToolResult | null {
  if (target.kind !== "delete") {
    const missing = deps.missingStepDeliverables(target);
    if (missing.length > 0) {
      const existing = deps.stillExistingDeliverables(target);
      const allGone = deps.hasStepDeliverables(target) && existing.length === 0;
      if (allGone) {
        // Подтверждаем, что агент реально удалил эти файлы (а не просто
        // никогда не создавал) перед авто-переключением.
        const wasDeleted = deps.wasFileDeleted
          ? missing.every((f) => deps.wasFileDeleted!(f))
          : false;
        if (wasDeleted) {
          switchStepToDelete(tracker.getPlan(), target, (p) => deps.persistPlan(p));
        }
      }
    }
    return null;
  }
  const leftovers = deps.stillExistingDeliverables(target);
  if (leftovers.length === 0 && deps.wasFileDeleted) {
    const tokens = deps.missingStepDeliverables(target);
    if (tokens.length > 0 && tokens.every((f) => !deps.wasFileDeleted!(f))) {
      switchStepToCreate(tracker.getPlan(), target, (p) => deps.persistPlan(p));
      return {
        success: false,
        output: t("plan.deliverables_missing", {
          step: String(stepId),
          files: tokens.join(", "),
        }),
      };
    }
  }
  return null;
}

/**
 * Проверяет check-контракт шага на done. "file-exists:" верифицируется жёстко
 * здесь (kind=delete инвертирует: файл обязан ОТСУТСТВОВАТЬ); "command:"/"manual:"
 * self-certified с подтверждающей заметкой. Шаги вовсе без check — только из
 * до-чековых планов (back-compat), заметки не дают.
 */
async function verifyCheckContract(
  deps: PlanToolDeps,
  target: PlanStep,
  stepId: number,
): Promise<{ note: string; blocked: ToolResult | null }> {
  if (!target.check) return { note: "", blocked: null };
  const parsed = parseCheck(target.check);
  if (parsed?.kind === "file") {
    const res = await deps.verifier.checkFileExists(parsed.target);
    const ok = target.kind === "delete" ? !res.passed : res.passed;
    if (!ok) {
      return {
        note: "",
        blocked: {
          success: false,
          output: t("plan.check_failed", {
            step: String(stepId),
            check: target.check,
          }),
        },
      };
    }
    return { note: "", blocked: null };
  }
  if (parsed) {
    return { note: `\n${t("plan.check_self_certified", { check: target.check })}`, blocked: null };
  }
  return { note: "", blocked: null };
}

/**
 * Сеттлит повторную метку на уже завершённом плане: архив + очистка, чтобы
 * модель создала свежий план вместо прокрутки готового (было: 3× "plan update
 * step=4 done" на плане 4/4, пока ждала НОВАЯ задача). Возвращает результат
 * завершения, или null если план ещё в работе.
 */
function settleCompletedPlan(deps: PlanToolDeps, tracker: PlanTracker): ToolResult | null {
  if (!tracker.isComplete()) return null;
  const plan = tracker.getPlan();
  deps.store.archivePlan(plan);
  deps.recordCompleted(plan); // финальный аудит его всё равно проверит
  deps.trackerRef.current = null;
  const p = getPlanProgress(plan);
  return {
    success: true,
    output: t("plan.completed_archived", {
      id: plan.id,
      done: String(p.settled),
      total: String(plan.steps.length),
    }),
  };
}

/**
 * Идемпотентная переметка: подтверждение уже-done шага — УСПЕХ (мелкая модель
 * читает success:false как провал действия и ретраит/спиннится). Настоящий
 * спиннинг ловит stuck-детектор.
 */
function checkIdempotentDone(
  tracker: PlanTracker,
  target: PlanStep,
  stepId: number,
  status: string,
): ToolResult | null {
  if (status !== "done" || target.status !== "done") return null;
  const progress = tracker.getProgressString();
  const display = tracker.toPromptBlock();
  return {
    success: true,
    output: `${t("plan.step_already_done", {
      step: String(stepId),
    })}\n${progress}`,
    display,
  };
}

/**
 * Порядок: done маркится только ТЕКУЩИЙ шаг (защита от прыжков вперёд —
 * было: step 5 done раньше шагов 1-4, затем аудит "5/5 steps done, 5 files
 * missing").
 */
function enforceStepOrder(
  tracker: PlanTracker,
  stepId: number,
): ToolResult | null {
  const blockers = tracker
    .getPlan()
    .steps.filter((s) => s.id < stepId && s.status !== "done" && s.status !== "skipped");
  if (blockers.length === 0) return null;
  return {
    success: false,
    output: t("plan.order_blocked", {
      step: String(stepId),
      first: String(blockers[0].id),
      desc: blockers[0].description,
    }),
  };
}

/**
 * Deliverable-gate: done обязан совпасть с (уже kind-резолвленным) намерением —
 * "create" требует файлы на месте, "delete" — их ОТСУТСТВИЕ.
 */
function checkDeliverables(
  deps: PlanToolDeps,
  target: PlanStep,
  stepId: number,
): ToolResult | null {
  if (target.kind === "delete") {
    const leftovers = deps.stillExistingDeliverables(target);
    if (leftovers.length > 0) {
      return {
        success: false,
        output: t("plan.deliverables_remain", {
          step: String(stepId),
          files: leftovers.join(", "),
        }),
      };
    }
    return null;
  }
  const missing = deps.missingStepDeliverables(target);
  if (missing.length > 0) {
    return {
      success: false,
      output: t("plan.deliverables_missing", {
        step: String(stepId),
        files: missing.join(", "),
      }),
    };
  }
  return null;
}

/**
 * Typecheck-gate: "done" при всё ещё не компилирующейся последней записи —
 * самосертификация, которую харнесс обязан реджектить (было: шаги маркились
 * done при падающем на каждой записи typecheck проекта). Чини или скипай.
 */
function checkTypecheckGate(
  deps: PlanToolDeps,
  target: PlanStep,
  stepId: number,
): ToolResult | null {
  const blocked = stepTypecheckGate(deps.typecheckFailures, target.description);
  if (!blocked) return null;
  return {
    success: false,
    output: t("plan.typecheck_failed", {
      step: String(stepId),
      error: blocked,
    }),
  };
}

/** Общий контекст, протянутый через done-гарды ниже. */
interface StepGuardCtx {
  deps: PlanToolDeps;
  tracker: PlanTracker;
  target: PlanStep;
  stepId: number;
  status: string;
  /** Заметка самосертификации, накопленная check-гардом. */
  checkNote: string;
}

type StepGuard = (c: StepGuardCtx) => ToolResult | Promise<ToolResult | null> | null;

function guardKnownStatus(c: StepGuardCtx): ToolResult | null {
  if ((STEP_UPDATE_STATUSES as readonly string[]).includes(c.status)) return null;
  return {
    success: false,
    output: t("plan.bad_status", {
      status: c.status,
      allowed: STEP_UPDATE_STATUSES.join(", "),
    }),
  };
}

function guardSettledPlan(c: StepGuardCtx): ToolResult | null {
  return settleCompletedPlan(c.deps, c.tracker);
}

function guardIdempotent(c: StepGuardCtx): ToolResult | null {
  return checkIdempotentDone(c.tracker, c.target, c.stepId, c.status);
}

function guardOrder(c: StepGuardCtx): ToolResult | null {
  if (c.status !== "done") return null;
  return enforceStepOrder(c.tracker, c.stepId);
}

async function guardKindAndCheck(c: StepGuardCtx): Promise<ToolResult | null> {
  if (c.status !== "done") return null;
  // Kind резолвится из поведения первым (оба направления), затем check-
  // контракт проверяется против резолвленного kind: шаг, флипнутый агентом в
  // delete, оценивает файловый check как delete.
  const resolved = autoResolveStepKind(c.deps, c.tracker, c.target, c.stepId);
  if (resolved) return resolved;
  const check = await verifyCheckContract(c.deps, c.target, c.stepId);
  if (check.blocked) return check.blocked;
  c.checkNote = check.note;
  return null;
}

function guardDeliverables(c: StepGuardCtx): ToolResult | null {
  if (c.status !== "done") return null;
  return checkDeliverables(c.deps, c.target, c.stepId);
}

function guardTypecheck(c: StepGuardCtx): ToolResult | null {
  if (c.status !== "done") return null;
  return checkTypecheckGate(c.deps, c.target, c.stepId);
}

/** Done-гарды в порядке оценки — та же цепочка, что старый инлайн-чейн. */
const STEP_GUARDS: StepGuard[] = [
  guardKnownStatus,
  guardSettledPlan,
  guardIdempotent,
  guardOrder,
  guardKindAndCheck,
  guardDeliverables,
  guardTypecheck,
];

/** Обновляет шаг плана через цепочку done-гардов; на последнем шаге — авто-архив. */
export async function updatePlanStep(deps: PlanToolDeps, ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const tracker = deps.trackerRef.current!;
  const stepId = Number(args.step);
  const target = tracker.getStep(stepId);
  if (!target) {
    return { success: false, output: t("plan.step_not_found") };
  }
  const gctx: StepGuardCtx = {
    deps,
    tracker,
    target,
    stepId,
    status: String(args.status || "done"),
    checkNote: "",
  };
  for (const guard of STEP_GUARDS) {
    const blocked = await guard(gctx);
    if (blocked) return blocked;
  }
  const status = gctx.status;
  const checkNote = gctx.checkNote;

  tracker.updateStepStatus(stepId, status as StepUpdateStatus);
  if (args.note) tracker.addNote(Number(args.step), String(args.note));
  tracker.syncCurrentStep();
  deps.persistPlan(tracker.getPlan());
  // Шаги без файловых токенов нормальны в некодовых задачах (research, советы,
  // сравнения) — не гоним модель материализовывать файлы ради deliverables.
  // Заметка срабатывает только в планах с хоть одним файловым шагом и просит
  // лишь task-appropriate проверку.
  const planSteps = tracker.getPlan().steps ?? [];
  const planHasFiles = planSteps.some((s) => deps.hasStepDeliverables(s));
  const vacuousGate = status === "done" && planHasFiles && !deps.hasStepDeliverables(target);
  const vacuousNote = vacuousGate
    ? `\n${t("plan.no_deliverables", { step: String(stepId) })}`
    : "";

  // Это обновление закрыло последний шаг → авто-архив. Рвёт петлю, где готовый
  // план остаётся активным и якорит модель на "продолжай шаг N, НЕ создавай
  // новый план".
  if (tracker.isComplete()) {
    const plan = tracker.getPlan();
    deps.store.archivePlan(plan);
    deps.recordCompleted(plan); // финальный аудит его всё равно проверит
    deps.trackerRef.current = null;
    const p = getPlanProgress(plan);
    return {
      success: true,
      output: `${t("plan.step_status", { step: String(args.step), status: String(args.status || "done") })}\n${t(
        "plan.completed_archived",
        {
          id: plan.id,
          done: String(p.settled),
          total: String(plan.steps.length),
        },
      )}${vacuousNote}${checkNote}`,
    };
  }

  const progress = tracker.getProgressString();
  const display = tracker.toPromptBlock();
  ctx.sessionLog?.plan(
    "step-update",
    `${t("plan.step_status", { step: String(args.step), status: String(args.status || "done") })} | ${progress} | current: step ${tracker.getCurrentStepIndex() + 1}`,
  );
  return {
    success: true,
    output: `${t("plan.step_status", { step: String(args.step), status: String(args.status || "done") })}\n${progress}${vacuousNote}${checkNote}`,
    display,
  };
}

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