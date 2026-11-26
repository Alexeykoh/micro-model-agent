// AQC-1/AQC-2: доказательства не само-одобряются, а шаг с check не закрывается
// в обход verifyCheckContract. Регресс сессии ses_mwor4q49: evidence:"static"
// на .tsx и шаг `done` без фактической правки файла.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { needsBehaviorEvidence } from "../../src/modules/execution/plan-checks";
import { PlanCreator } from "../../src/modules/execution/planner";
import { autoCloseEvidenceSteps } from "../../src/modules/execution/final-audit";
import { advancePlanIfStepComplete } from "../../src/modules/execution/step-advance";
import type { FinalAuditHost } from "../../src/modules/execution/final-audit";
import type { StepAdvanceDeps } from "../../src/modules/execution/step-advance";

describe("AQC-1: пропущенное evidence = behavioral", () => {
  it("отсутствие поля требует поведенческого доказательства", () => {
    expect(needsBehaviorEvidence({})).toBe(true);
    expect(needsBehaviorEvidence({ evidence: undefined })).toBe(true);
    expect(needsBehaviorEvidence({ evidence: "behavioral" })).toBe(true);
    expect(needsBehaviorEvidence({ evidence: "static" })).toBe(false);
  });

  it("re-plan не понижает behavioral до static", () => {
    const plan = PlanCreator.createPlan(
      "Фильтры",
      ["Исправить src/components/filter-panel.tsx"],
      "C:/base",
      [],
      ["file-modified:src/components/filter-panel.tsx"],
      [],
      ["behavioral"],
    );
    const replanned = PlanCreator.replan(
      plan,
      ["Исправить src/components/filter-panel.tsx"],
      undefined,
      ["file-modified:src/components/filter-panel.tsx"],
      [],
      ["static"],
    );
    expect(replanned.steps[0]!.evidence).toBe("behavioral");
  });
});

describe("AQC-2: шаг с check не закрывается в обход проверки", () => {
  it("финальный аудит не авто-закрывает шаг с check", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-aqc2-close-"));
    try {
      writeFileSync(join(dir, "README.md"), "# Project documentation here\n");
      const plan = PlanCreator.createPlan(
        "Доки",
        ["Измени README.md"],
        dir,
        [],
        ["file-modified:README.md"],
        ["deadbeef"],
        ["static"],
      );
      const closed = autoCloseEvidenceSteps({ baseDir: dir } as FinalAuditHost, plan);
      expect(closed).toBe(0);
      expect(plan.steps[0]!.status).toBe("pending");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("auto-advance не закрывает file-modified по mtime", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-aqc2-advance-"));
    try {
      const path = join(dir, "a.ts");
      writeFileSync(path, "export const a = 1;\n");
      const plan = PlanCreator.createPlan(
        "Правка",
        ["Измени a.ts"],
        dir,
        [],
        ["file-modified:a.ts"],
      );
      const steps: Array<{ role: "user"; content: string }> = [];
      const d = {
        baseDir: dir,
        tracker: {
          getCurrentStep: () => plan.steps[0],
          getPlan: () => plan,
          updateStepStatus: () => {
            throw new Error("step must not be closed without hash check");
          },
        },
        store: { saveActive: () => undefined },
        depsGateHints: new Map(),
        pendingMessages: steps,
        autoAdvance: true,
        typecheckFailures: new Map(),
        flushSessionPlan: () => undefined,
        setPendingAutoArchive: () => undefined,
      } as unknown as StepAdvanceDeps;
      expect(() => advancePlanIfStepComplete(d)).not.toThrow();
      expect(plan.steps[0]!.status).toBe("pending");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
