// Guard: финальный аудит не авто-закрывает шаг, объявивший поведенческое
// доказательство, по факту существования файла (сессия ses_mwmeoln9).
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { autoCloseEvidenceSteps } from "../../src/modules/execution/final-audit";
import { PlanCreator } from "../../src/modules/execution/planner";
import type { FinalAuditHost } from "../../src/modules/execution/final-audit";

describe("autoCloseEvidenceSteps и declarative evidence", () => {
  it("behavioral-шаг остаётся pending", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-autoclose-evidence-"));
    try {
      writeFileSync(join(dir, "movement.ts"), "export const MOVE_COOLDOWN_SEC = 0.5;\n");
      const plan = PlanCreator.createPlan(
        "Скорость движения",
        ["Исправь movement.ts: 1 клетка за нажатие"],
        dir,
        [],
        ["command:bun test"],
        [],
        ["behavioral"],
      );
      const host = { baseDir: dir } as FinalAuditHost;
      const closed = autoCloseEvidenceSteps(host, plan);
      expect(closed).toBe(0);
      expect(plan.steps[0]!.status).toBe("pending");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("static-шаг по-прежнему авто-закрывается", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-autoclose-static-"));
    try {
      writeFileSync(join(dir, "README.md"), "# Project documentation here\n");
      const plan = PlanCreator.createPlan(
        "Доки",
        ["Создай README.md"],
        dir,
        [],
        ["file-exists:README.md"],
      );
      const host = { baseDir: dir } as FinalAuditHost;
      const closed = autoCloseEvidenceSteps(host, plan);
      expect(closed).toBe(1);
      expect(plan.steps[0]!.status).toBe("done");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
