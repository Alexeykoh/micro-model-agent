import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  runFinalAudit,
  type FinalAuditHost,
} from "../../src/modules/execution/final-audit";
import { PlanCreator, type Plan } from "../../src/modules/execution/planner";
import { PlanTracker } from "../../src/modules/execution/tracker";
import type { PluginHookContext } from "../../src/modules/types";
import type { ToolCall, ToolResult } from "../../src/tools/types";
import { t } from "../../src/i18n/index";
import {
  cleanupTestModule,
  createTestModule,
  writeTestFile,
} from "../plan-test-utils";

/**
 * Дефект C (спека 0.25.2): `summary` и `passed` финального аудита считались
 * по разным условиям — сообщение печатало «[✓] Задача выполнена» рядом с
 * «проверка не пройдена», а auto-advance закрывал `manual:`-шаг без заметки.
 */

function passSummary(done: string, total: string, files: string): string {
  return t("exec.audit_pass", { done, total, files });
}

function makeAuditor(summary: string): FinalAuditHost["auditor"] {
  return {
    audit: async () => ({
      passed: true,
      missingFiles: [],
      leftoverFiles: [],
      createdFiles: [],
      modifiedFiles: [],
      summary,
      massEditWarning: null,
      testRun: null,
      testNote: null,
      typecheckError: null,
    }),
  } as FinalAuditHost["auditor"];
}

function makeHost(
  baseDir: string,
  plan: Plan,
  auditor: FinalAuditHost["auditor"],
): FinalAuditHost {
  return {
    baseDir,
    tracker: new PlanTracker(plan),
    completedPlan: null,
    auditor,
    store: { saveActive: () => {} } as FinalAuditHost["store"],
    auditSkipsRemaining: 0,
    mutatedThisTurn: false,
    typecheckFailures: new Map(),
    setAuditSkipsRemaining: () => {},
    flushSessionPlan: () => {},
  };
}

describe("final audit summary consistency (C)", () => {
  let baseDir: string;
  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "mma-audit-c-"));
  });
  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("reports pending manual steps in the summary instead of '[✓] Task complete'", async () => {
    const plan = PlanCreator.createPlan(
      "T",
      ["Update src/ui.tsx"],
      baseDir,
      undefined,
      ["manual:verify the UI"],
    );
    plan.steps[0].status = "done";

    const result = await runFinalAudit(makeHost(baseDir, plan, makeAuditor(passSummary("1", "1", "0"))));

    expect(result).not.toBeNull();
    expect(result!.passed).toBe(false);
    expect(result!.pendingSteps.length).toBeGreaterThan(0);
    expect(result!.summary).toContain("Task incomplete");
    expect(result!.summary).toContain("Update src/ui.tsx");
    expect(result!.summary).not.toContain("[✓]");
  });

  it("keeps the pass summary when nothing is pending", async () => {
    const plan = PlanCreator.createPlan(
      "T",
      ["Create src/a.ts"],
      baseDir,
      undefined,
      ["file-exists:src/a.ts"],
    );
    plan.steps[0].status = "done";

    const result = await runFinalAudit(makeHost(baseDir, plan, makeAuditor(passSummary("1", "1", "1"))));

    expect(result!.passed).toBe(true);
    expect(result!.summary).toBe(passSummary("1", "1", "1"));
  });
});

describe("auto-advance manual guard (C)", () => {
  let tmpDir: string;
  let execModule: ReturnType<typeof createTestModule>["execModule"];

  beforeEach(() => {
    ({ tmpDir, execModule } = createTestModule("mma-audit-c-adv-"));
  });
  afterEach(() => {
    cleanupTestModule(tmpDir);
  });

  it("does not close a manual step without a note", async () => {
    const tool = execModule.getToolDefinitions().find((td) => td.name === "plan")!;
    const res = await tool.handler({}, {
      action: "create",
      title: "T",
      steps: ["Update src/ui.tsx"],
      checks: ["manual:verify the UI"],
    });
    expect(res.success).toBe(true);

    writeTestFile(tmpDir, "src/ui.tsx");
    const plugin = execModule.getPlugin();
    const hookCtx = {
      contextManager: { addMessage: () => {} },
      sessionLog: { plan: () => {} },
    } as PluginHookContext;
    plugin.onAfterTool!(
      hookCtx,
      { name: "write_file", arguments: { path: "src/ui.tsx" } } as ToolCall,
      { success: true, output: "ok" } as ToolResult,
    );

    expect(execModule.getTracker()!.getStep(1)!.status).not.toBe("done");
  });
});
