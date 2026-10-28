// Done-гарды шага и их цепочка (вынесено из step-update.ts, правило 6).
import type { ToolResult } from "../../tools/types";
import { t } from "../../i18n/index";
import { getPlanProgress, type PlanStep } from "./planner";
import type { PlanTracker } from "./tracker";
import { checkDoneEvidence, parseCheck } from "./plan-checks";
import { stepTypecheckGate } from "./execution-plugin";
import { switchStepToCreate, switchStepToDelete } from "./plan-steps";
import type { PlanToolDeps } from "./plan-tool";

/**
 * Статусы, которые plan update вправе ставить. Остальное (произвольный текст
 * модели, pending/in_progress) реджектится: неизвестный статус не закроет
 * isComplete(), план крутился бы вечно, а мусор персистился бы в
 * .mma/plans/active.json.
 */
export const STEP_UPDATE_STATUSES = ["done", "failed", "skipped"] as const;
export type StepUpdateStatus = (typeof STEP_UPDATE_STATUSES)[number];

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
    return (await checkDoneEvidence(parsed, target, stepId)) ?? { note: `\n${t("plan.check_self_certified", { check: target.check })}`, blocked: null };
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
export interface StepGuardCtx {
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
export const STEP_GUARDS: StepGuard[] = [
  guardKnownStatus,
  guardSettledPlan,
  guardIdempotent,
  guardOrder,
  guardKindAndCheck,
  guardDeliverables,
  guardTypecheck,
];
