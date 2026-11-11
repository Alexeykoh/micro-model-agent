// Check-контракт шага на done (вынесено из step-guards.ts, правило 6).
import type { ToolResult, ToolScope } from "../../tools/types";
import { t } from "../../i18n/index";
import type { PlanStep } from "./planner";
import { checkDoneEvidence, parseCheck, staticEvidenceForBehaviorStep } from "./plan-checks";
import type { PlanToolDeps } from "./plan-tool";

/**
 * Проверяет check-контракт шага на done. "file-exists:"/"file-modified:"
 * верифицируются жёстко здесь (kind=delete инвертирует file-exists: файл
 * обязан ОТСУТСТВОВАТЬ); "command:"/"manual:" self-certified с подтверждающей
 * заметкой. Шаги вовсе без check — только из до-чековых планов
 * (back-compat), заметки не дают.
 */
export async function verifyCheckContract(
  deps: PlanToolDeps,
  target: PlanStep,
  stepId: number,
  scope?: ToolScope,
): Promise<{ note: string; blocked: ToolResult | null }> {
  if (!target.check) return { note: "", blocked: null };
  const parsed = parseCheck(target.check);
  if (parsed?.kind === "file-modified") {
    const res = await deps.verifier.checkFileModified(parsed.target, target.checkBaseline, scope);
    if (!res.passed) {
      return {
        note: "",
        blocked: {
          success: false,
          output: `${t("plan.check_failed", {
            step: String(stepId),
            check: target.check,
          })}\n${res.message}`,
        },
      };
    }
    return staticEvidenceForBehaviorStep(parsed, target, stepId);
  }
  if (parsed?.kind === "file") {
    const res = await deps.verifier.checkFileExists(parsed.target, scope);
    const ok = target.kind === "delete" ? !res.passed : res.passed;
    if (!ok) {
      return {
        note: "",
        blocked: {
          success: false,
          output: `${t("plan.check_failed", {
            step: String(stepId),
            check: target.check,
          })}\n${res.message}`,
        },
      };
    }
    // Файловый контракт — тоже статика: на поведенческом/UI-шаге он не
    // подтверждает шаг (дефект F).
    return staticEvidenceForBehaviorStep(parsed, target, stepId);
  }
  if (parsed) {
    return (
      (await checkDoneEvidence(parsed, target, stepId, {
        baseDir: deps.baseDir,
        ...(deps.networkSecurity ? { networkSecurity: deps.networkSecurity } : {}),
      })) ?? {
        note: `\n${t("plan.check_self_certified", { check: target.check })}`,
        blocked: null,
      }
    );
  }
  return { note: "", blocked: null };
}
