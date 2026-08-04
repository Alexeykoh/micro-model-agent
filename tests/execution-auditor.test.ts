import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Auditor } from "../src/modules/execution/auditor";
import { PlanCreator } from "../src/modules/execution/planner";

describe("Auditor", () => {
  let tmpDir: string;
  let auditor: Auditor;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-audit-"));
    auditor = new Auditor(tmpDir);
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it("should pass when all step files exist", async () => {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src/index.ts"), "");
    writeFileSync(join(tmpDir, "src/utils.ts"), "");

    const plan = PlanCreator.createPlan(
      "test",
      [
        "Create src/index.ts file with content",
        "Create src/utils.ts file with content",
      ],
      tmpDir,
    );
    plan.steps[0].status = "done";
    plan.steps[1].status = "done";

    const result = await auditor.audit(plan);
    expect(result.passed).toBe(true);
    expect(result.missingFiles).toEqual([]);
  });

  it("should fail when files missing", async () => {
    const plan = PlanCreator.createPlan(
      "test",
      [
        "Create src/index.ts with real content",
        "Create src/missing.ts with content",
      ],
      tmpDir,
    );
    plan.steps[0].status = "done";
    plan.steps[1].status = "done";

    const result = await auditor.audit(plan);
    expect(result.passed).toBe(false);
    expect(result.missingFiles.length).toBeGreaterThan(0);
  });

  it("should produce summary", async () => {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src/index.ts"), "");

    const plan = PlanCreator.createPlan(
      "test",
      ["Create src/index.ts with main function"],
      tmpDir,
    );
    plan.steps[0].status = "done";

    const result = await auditor.audit(plan);
    expect(result.summary).toMatch(/complete/i);
  });

  it("should warn on mass edit (>10 files)", async () => {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    const files = Array.from({ length: 15 }, (_, i) => `src/file${i}.ts`);
    files.forEach((f) => writeFileSync(join(tmpDir, f), ""));

    const plan = PlanCreator.createPlan(
      "test",
      files.map((f) => `Create ${f}`),
      tmpDir,
    );
    plan.steps.forEach((s) => (s.status = "done"));

    const result = await auditor.audit(plan);
    expect(result.massEditWarning).toBeTruthy();
    expect(result.massEditWarning).toContain("15");
  });

  it("should not warn on small edit (<=10 files)", async () => {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src/index.ts"), "");

    const plan = PlanCreator.createPlan(
      "test",
      ["Create src/index.ts"],
      tmpDir,
    );
    plan.steps[0].status = "done";

    const result = await auditor.audit(plan);
    expect(result.massEditWarning).toBeNull();
  });
});
