/**
 * Финальный аудит исполнения (`execution/module.ts`, INV-23): evidence-based
 * автозакрытие пендинг-шагов с деливераблами на диске и сам аудит плана
 * (файлы/тесты/tsc/пендинги). Вынесено из класса `ExecutionModule`.
 */
import { readFileSync } from "fs";
import { extractFileLikeTokens, stripUrls } from "../../core/hallucination/js-identifiers";
import { findExistingFile } from "./auditor";
import { provablyStale } from "./step-advance";
import type { Auditor } from "./auditor";
import type { PlanTracker } from "./tracker";
import type { PlanStore } from "./plan-store";
import type { Plan, PlanStep } from "./planner";
import { isBehaviorStep, parseCheck } from "./plan-checks";

/** Результат финального аудита. */
export interface FinalAuditResult {
  passed: boolean;
  done: number;
  total: number;
  pendingSteps: string[];
  missingFiles: string[];
  summary: string;
  /** Пометка тестового прогона (скип/inconclusive/кэш) для лога, либо null. */
  testNote?: string | null;
}

/** Мутабельный вид `ExecutionModule`, которым владеет финальный аудит. */
export interface FinalAuditHost {
  baseDir: string;
  tracker: PlanTracker | null;
  completedPlan: Plan | null;
  auditor: Auditor;
  store: PlanStore;
  auditSkipsRemaining: number;
  /** За текущий ход были успешные файловые мутации (бюджет тест-прогона). */
  mutatedThisTurn: boolean;
  setAuditSkipsRemaining(n: number): void;
  flushSessionPlan(): void;
}

/**
 * Evidence-based автозакрытие пендинг шагов с deliverables на диске. Стандарт
 * ТОТ ЖЕ, что аудитор применяет к done-шагам: каждый файлоподобный токен
 * описания резолвится в существующий (непустой для create) файл.
 */
export function autoCloseEvidenceSteps(d: FinalAuditHost, plan: Plan): number {
  let closed = 0;
  for (const step of plan.steps) {
    if (step.status === "done" || step.status === "skipped") continue;
    const tokens = extractFileLikeTokens(stripUrls(step.description));
    if (tokens.length === 0) continue;
    const resolved = tokens.map((f) => findExistingFile(d.baseDir, f));

    if (step.kind === "delete") {
      // Delete-шаг закрыт, только если каждая именованная цель ОТСУТСТВУЕТ.
      if (resolved.some((r) => r !== null)) continue;
    } else {
      // create: каждая цель существует И непуста.
      if (resolved.some((r) => r === null)) continue;
      const empty = resolved.some((r) => {
        try {
          return readFileSync(r!, "utf-8").trim().length < 10;
        } catch {
          return false; // unreadable — fall back to existence
        }
      });
      if (empty) continue;
      // Vacuous-truth guard: пендинг-шаг по доказанно старым файлам не закрываем.
      if (provablyStale(resolved, Date.parse(plan.createdAt))) continue;
    }

    step.status = "done";
    step.note = `auto-closed by final audit: ${
      step.kind === "delete" ? "all named files removed" : "all named files exist with content"
    } (${tokens.join(", ")})`;
    closed++;
  }
  return closed;
}

/**
 * Шаг считается незакрытым, если он не done/skipped ИЛИ закрыт по `manual:`,
 * но без наблюдения (W2 спеки turn-runtime-gate): «проверил глазами» без
 * записи не подтверждает пункт.
 */
export function isUnconfirmed(s: PlanStep): boolean {
  if (s.status !== "done" && s.status !== "skipped") return true;
  if (s.status !== "done") return false;
  if (!isBehaviorStep(String(s.description || ""))) return false;
  const parsed = s.check ? parseCheck(s.check) : null;
  return parsed?.kind === "manual" && !String(s.note || "").trim();
}

/**
 * Финальный аудит активного/завершённого плана: файлы, тесты, tsc, пендинги.
 * Null — аудитить нечего (нет трекера и завершённого плана).
 */
export async function runFinalAudit(d: FinalAuditHost): Promise<FinalAuditResult | null> {
  // Нет активного трекера: аудитим последний завершённый план вместо bail.
  if (!d.tracker) {
    if (!d.completedPlan) return null;
    const plan = d.completedPlan;
    const autoClosed = autoCloseEvidenceSteps(d, plan);
    const audit = await d.auditor.audit(plan, { mutated: d.mutatedThisTurn });
    const pendingSteps = plan.steps.flatMap((s) =>
      isUnconfirmed(s) ? [`${s.id}. ${s.description}`] : [],
    );
    const done = plan.steps.filter((s) => s.status === "done").length;
    if (autoClosed > 0) {
      d.store.saveActive(plan);
      d.flushSessionPlan();
    }
    return {
      passed: audit.passed && pendingSteps.length === 0,
      done,
      total: plan.steps.length,
      pendingSteps,
      missingFiles: audit.missingFiles,
      summary: audit.summary,
      testNote: audit.testNote,
    };
  }
  if (d.auditSkipsRemaining > 0) {
    d.setAuditSkipsRemaining(d.auditSkipsRemaining - 1);
    return null;
  }
  const plan = d.tracker.getPlan();
  const autoClosed = autoCloseEvidenceSteps(d, plan);
  if (autoClosed > 0) {
    d.store.saveActive(plan);
    d.flushSessionPlan();
  }
  const audit = await d.auditor.audit(plan, { mutated: d.mutatedThisTurn });
  const pendingSteps = plan.steps.flatMap((s) =>
    isUnconfirmed(s) ? [`${s.id}. ${s.description}`] : [],
  );
  const done = plan.steps.filter((s) => s.status === "done").length;
  return {
    passed: audit.passed && pendingSteps.length === 0,
    done,
    total: plan.steps.length,
    pendingSteps,
    missingFiles: audit.missingFiles,
    summary: audit.summary,
    testNote: audit.testNote,
  };
}
