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
 * Действия плана, вынесенные из монолитного обработчика `plan` в
 * plan-tool.ts (был god-function на 517 строк с цепочкой `if (action === ...)`).
 * Теперь — по одной функции на действие и словарь-диспетчер.
 */
export type PlanAction = (
  deps: PlanToolDeps,
  ctx: ToolContext,
  args: Record<string, unknown>,
) => Promise<ToolResult> | ToolResult;

/**
 * Statuses `plan update` may set. Anything else (arbitrary model text, or
 * `pending`/`in_progress`) is rejected: an unknown status never settles
 * `isComplete()`, so the plan would spin forever and the bogus value would be
 * persisted to `.mma/plans/active.json`.
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
  // Switching to the plan that is already active must be a no-op, not
  // a duplicate (observed: switch on the active plan preserved the
  // active.json and re-set the same plan, leaving two copies).
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
  // Display from the tracker (setPlan syncs the pointer past any
  // done/skipped steps) so "current: step N" points at the first
  // pending step of the switched-to plan, not always step 1.
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
    return { success: false, output: t("plan.no_active") };
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

  // Coverage is validated BEFORE any state mutation: a blocked create must
  // not leak a half-created active plan (the next create would then trip
  // over active_in_progress on a plan the model never saw succeed).
  const taskText = deps.getTaskText(ctx);
  if (taskText) {
    const { missing } = checkPlanCoverage(taskText, steps);
    if (missing.length > 0) {
      // Hard block (not a warning): a 9B model reads "success:true + ⚠️" as
      // success and works on garbage for 5+ iterations before the
      // deliverable gate stops it. Stop at creation with the file list.
      return {
        success: false,
        output: t("plan.coverage_blocked", {
          missing: missing.join(", "),
        }),
      };
    }
  }

  // Never silently discard an in-progress plan (observed:
  // ses_msvuao0h — right after compaction the model called
  // `plan create` again, dumping the 1/6 plan into drafts and
  // starting from scratch). An active plan WITH progress blocks
  // creation until the model consciously aborts it. A fresh plan
  // (all steps pending) is safe to replace — the model may have
  // just changed its mind about the approach.
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
  // The model sometimes passes an id expecting the plan to be
  // created under it (observed: id "plan_error_check_e07pb2" was
  // ignored, a new id appeared). Be explicit so it doesn't look
  // for a plan by the wrong id afterwards.
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
    // Show a specific plan (active, draft, or archived) instead
    // of ignoring the id and always printing the active one
    // (observed: the model asked for an archived plan three
    // times and got the active plan back every time).
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
    return { success: false, output: t("plan.no_active") };
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
 * Resolve a step's create/delete kind from what the agent DID (not declared).
 * Forward: create-kind step whose files are all gone AND tracked as deleted
 * → flip to delete. Reverse: delete-kind step whose files neither exist nor
 * were ever deleted → flip to create and block (a vacuous pass would certify
 * nothing; user-deleted-outside files are the known tradeoff — skip the step).
 * Returns a blocking ToolResult for the reverse case, null otherwise.
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
        // Confirm the agent actually deleted these files (not just
        // never created them) before auto-switching.
        const wasDeleted = deps.wasFileDeleted
          ? missing.every((f) => deps.wasFileDeleted!(f))
          : false;
        if (wasDeleted) {
          switchStepToDelete(tracker.getPlan(), target, (p) => deps.store.saveActive(p));
        }
      }
    }
    return null;
  }
  const leftovers = deps.stillExistingDeliverables(target);
  if (leftovers.length === 0 && deps.wasFileDeleted) {
    const tokens = deps.missingStepDeliverables(target);
    if (tokens.length > 0 && tokens.every((f) => !deps.wasFileDeleted!(f))) {
      switchStepToCreate(tracker.getPlan(), target, (p) => deps.store.saveActive(p));
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
 * Verify a step's check contract on done. "file-exists:" is hard-verified
 * here (delete-kind inverts it: the file must be GONE); "command:"/"manual:"
 * are self-certified and contribute a confirmation note. Steps without any
 * check come only from pre-checks plans (back-compat) and yield no note.
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
 * Settle a re-mark on an already-complete plan: archive + clear so the model
 * can create a fresh plan instead of spinning on the finished one (observed:
 * 3× "plan update step=4 done" on a 4/4 plan while a NEW task waited).
 * Returns the completion result, or null when the plan is still in progress.
 */
function settleCompletedPlan(deps: PlanToolDeps, tracker: PlanTracker): ToolResult | null {
  if (!tracker.isComplete()) return null;
  const plan = tracker.getPlan();
  deps.store.archivePlan(plan);
  deps.recordCompleted(plan); // final audit still verifies it
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
 * Idempotent re-mark: confirming an already-done step is SUCCESS (a small
 * model misreads success:false as a failed action and retries/spins).
 * Genuine spinning is still caught by the stuck-detector.
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
 * Order enforcement: only the CURRENT step may be marked done (prevents
 * jumping ahead — observed: step 5 done before steps 1-4, then audit
 * failures "5/5 steps done, 5 files missing").
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
 * Deliverable gate: done must match the (already kind-resolved) intent —
 * "create" needs named files present, "delete" needs them GONE.
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
 * Typecheck gate: "done" while the last write still fails to compile is a
 * self-certification the harness must refuse (observed: steps marked done
 * with the project typecheck failing on every write). Fix or skip.
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

/** Shared context threaded through the done-guards below. */
interface StepGuardCtx {
  deps: PlanToolDeps;
  tracker: PlanTracker;
  target: PlanStep;
  stepId: number;
  status: string;
  /** Self-certification note accumulated by the check guard. */
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
  // Kind is resolved from behavior first (both directions), then the check
  // contract is verified against the resolved kind — a step the agent
  // flipped to delete-kind evaluates its file check as delete.
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

/** Done-guards in evaluation order — same sequence as the old inline chain. */
const STEP_GUARDS: StepGuard[] = [
  guardKnownStatus,
  guardSettledPlan,
  guardIdempotent,
  guardOrder,
  guardKindAndCheck,
  guardDeliverables,
  guardTypecheck,
];

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
  deps.store.saveActive(tracker.getPlan());
  // Steps without file tokens are normal in non-code tasks (research,
  // advice, comparison) — never push the model to materialize files just
  // to have deliverables. The note fires only inside plans that contain
  // at least one file-bearing step, and asks only for a
  // task-appropriate check.
  const planSteps = tracker.getPlan().steps ?? [];
  const planHasFiles = planSteps.some((s) => deps.hasStepDeliverables(s));
  const vacuousGate = status === "done" && planHasFiles && !deps.hasStepDeliverables(target);
  const vacuousNote = vacuousGate
    ? `\n${t("plan.no_deliverables", { step: String(stepId) })}`
    : "";

  // If this update completed the last step → auto-archive. This breaks
  // the loop where a finished plan stays active and anchors the model
  // to "continue step N, do NOT create a new plan".
  if (tracker.isComplete()) {
    const plan = tracker.getPlan();
    deps.store.archivePlan(plan);
    deps.recordCompleted(plan); // final audit still verifies it
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
    // Abort a SPECIFIC plan (not the active one). Draft → archive,
    // active → archive + clear tracker. Archived plans are already
    // terminal — there is nothing to abort.
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
    deps.store.archivePlan(found.plan); // clears active if it was active
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
    // Abort with no active plan and no id — previously returned
    // success:true, which made the model believe it aborted a plan
    // that did not exist (observed: 3× abort on an empty list).
    return { success: false, output: t("plan.no_active") };
  }
  deps.store.archivePlan(tracker.getPlan());
  deps.trackerRef.current = null;
  deps.store.clearActive();
  deps.clearCompleted();
  return { success: true, output: t("plan.aborted") };
}

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
    // Update with an id that points at a draft/archived plan: say the
    // plan is read-only instead of a bare "No active plan" (observed:
    // 10+ iterations re-updating an archived plan and getting the same
    // unhelpful answer back).
    if (args.id) {
      const found = deps.store.find(String(args.id));
      if (found && found.status !== "active") {
        return {
          success: false,
          output: t("plan.readonly", { id: found.plan.id, status: found.status }),
        };
      }
    }
    return { success: false, output: t("plan.no_active") };
  }
  return {
    success: false,
    output: t("plan.unknown_action", { action }),
  };
}

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