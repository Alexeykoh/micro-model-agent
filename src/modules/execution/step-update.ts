// Обновление шага плана; done-гарды — в step-guards.ts (правило 6).
import type { ToolResult, ToolContext } from "../../tools/types";
import { t } from "../../i18n/index";
import { getPlanProgress } from "./planner";
import { isBehaviorStep, parseCheck } from "./plan-checks";
import type { PlanToolDeps } from "./plan-tool";
import { STEP_GUARDS, type StepGuardCtx, type StepUpdateStatus } from "./step-guards";

/**
 * `manual:`-проверка шага, меняющего поведение/UI, закрывается только вместе с
 * наблюдением (W2 спеки turn-runtime-gate): «проверил глазами» без записи — не
 * доказательство. Для research/доков `manual:` остаётся самоподтверждением.
 */
function requireManualEvidence(c: StepGuardCtx, note: string): ToolResult | null {
  if (c.status !== "done" || !c.target.check) return null;
  if (!isBehaviorStep(String(c.target.description || ""))) return null;
  const parsed = parseCheck(c.target.check);
  if (parsed?.kind !== "manual") return null;
  if (note.trim() || String(c.target.note || "").trim()) return null;
  return {
    success: false,
    output: t("plan.manual_needs_note", { step: String(c.stepId), check: c.target.check }),
  };
}

/** Обновляет шаг плана через цепочку done-гардов; на последнем шаге — авто-архив. */
export async function updatePlanStep(
  deps: PlanToolDeps,
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
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
    scope: ctx.scope,
    checkNote: "",
  };
  for (const guard of STEP_GUARDS) {
    const blocked = await guard(gctx);
    if (blocked) return blocked;
  }
  // W2: `manual:` — наблюдение обязательно, иначе шаг снова «самоподтверждён».
  const manualBlock = requireManualEvidence(gctx, String(args.note || ""));
  if (manualBlock) return manualBlock;
  const status = gctx.status;
  const checkNote = gctx.checkNote;

  tracker.updateStepStatus(stepId, status as StepUpdateStatus);
  if (args.note) tracker.addNote(Number(args.step), String(args.note));
  tracker.syncCurrentStep();
  deps.persistPlan(tracker.getPlan());
  // Наблюдение по `manual:` фиксируем в журнале сессии: аудит и человек видят,
  // ЧТО именно проверили, а не только слово «done».
  if (status === "done" && String(args.note || "").trim()) {
    const parsed = target.check ? parseCheck(target.check) : null;
    if (parsed?.kind === "manual") {
      ctx.sessionLog?.directive("verify_evidence", String(args.note), stepId);
    }
  }
  // Шаги без файловых токенов нормальны в некодовых задачах (research, советы,
  // сравнения) — не гоним модель материализовывать файлы ради deliverables.
  // Заметка срабатывает только в планах с хоть одним файловым шагом и просит
  // лишь task-appropriate проверку.
  const planSteps = tracker.getPlan().steps ?? [];
  const planHasFiles = planSteps.some((s) => deps.hasStepDeliverables(s));
  const vacuousGate = status === "done" && planHasFiles && !deps.hasStepDeliverables(target);
  const vacuousNote = vacuousGate ? `\n${t("plan.no_deliverables", { step: String(stepId) })}` : "";

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
