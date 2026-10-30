import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Auditor } from "../../../src/modules/execution/auditor";
import { PlanCreator } from "../../../src/modules/execution/planner";
import { processRegistry, type ManagedProcess } from "../../../src/modules/processes";
import * as auditRunners from "../../../src/modules/execution/audit-runners";
import { clearTestRunCache } from "../../../src/modules/execution/audit-test-cache";

/**
 * Контракт бюджета финального аудита (спека
 * `docs/specs/2026-10-30-audit-test-run-budget-design.md`): полный тест-прогон
 * не запускается, когда сломать тесты нечем; повторный аудит неизменного дерева
 * берётся из кэша; таймаут — `inconclusive`, а не «прошло».
 */

/** Прошедший прогон-фикстура (спаев на `runTests`). */
function fakeRun(over: Partial<auditRunners.TestRunCheck> = {}): auditRunners.TestRunCheck {
  return {
    checked: true,
    passed: true,
    status: "passed",
    failed: 0,
    passedCount: 3,
    detail: "3 passed",
    command: "bun test",
    durationMs: 12,
    ...over,
  };
}

describe("final audit test-run budget", () => {
  let tmpDir: string;
  let auditor: Auditor;
  let testFile: string;

  /** Проект с одним тестовым файлом и планом, шаг которого уже done. */
  function projectWithTests() {
    mkdirSync(join(tmpDir, "test"), { recursive: true });
    testFile = join(tmpDir, "test", "ok.test.ts");
    writeFileSync(testFile, "// ok\n");
    const plan = PlanCreator.createPlan("test", ["Create test/ok.test.ts"], tmpDir);
    plan.steps[0].status = "done";
    return plan;
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-audit-budget-"));
    auditor = new Auditor(tmpDir);
    clearTestRunCache();
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    clearTestRunCache();
  });

  it("does not spawn the runner when the turn had no file mutations", async () => {
    const plan = projectWithTests();
    const spy = vi.spyOn(auditRunners, "runTests").mockResolvedValue(fakeRun());

    const result = await auditor.audit(plan, { mutated: false });

    expect(spy).not.toHaveBeenCalled();
    expect(result.testRun).not.toBeNull();
    expect(result.testRun!.status).toBe("skipped");
    expect(result.testRun!.checked).toBe(false);
    expect(result.testRun!.detail).toContain("no file mutations");
    expect(result.testNote).toContain("skipped");
    // Скип не блокирует: сломать тесты было нечем.
    expect(result.passed).toBe(true);
  });

  it("serves the second audit on an unchanged tree from cache (no second spawn)", async () => {
    const plan = projectWithTests();
    const spy = vi.spyOn(auditRunners, "runTests").mockResolvedValue(fakeRun());

    const first = await auditor.audit(plan, { mutated: true });
    const second = await auditor.audit(plan, { mutated: true });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(first.testRun!.cached).toBeFalsy();
    expect(second.testRun!.cached).toBe(true);
    expect(second.testRun!.status).toBe("passed");
    expect(second.testRun!.durationMs).toBe(0);
    expect(second.testNote).toContain("cached");
  });

  it("an unfinished runner is inconclusive, never passed", async () => {
    const entry: ManagedProcess = {
      id: "proc_audit_budget",
      pid: 0,
      command: "bun test",
      cwd: tmpDir,
      status: "running",
      exitCode: null,
      startedAt: new Date().toISOString(),
      log: [],
    };
    vi.spyOn(processRegistry, "start").mockReturnValue(entry);
    const wait = vi.spyOn(processRegistry, "waitForExit").mockResolvedValue(false);
    vi.spyOn(processRegistry, "remove").mockReturnValue(true);

    const run = await auditRunners.runTests(tmpDir, { budgetMs: 25 });

    expect(wait).toHaveBeenCalledWith("proc_audit_budget", 25);
    expect(run.status).toBe("inconclusive");
    expect(run.passed).toBe(false);
    expect(run.detail).toContain("did not finish");
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("keeps an inconclusive run non-blocking but visible and uncached", async () => {
    const plan = projectWithTests();
    const spy = vi.spyOn(auditRunners, "runTests").mockResolvedValue(
      fakeRun({
        passed: false,
        status: "inconclusive",
        passedCount: 0,
        detail: "inconclusive: runner did not finish within 90s — result unknown, not a pass",
        durationMs: 90_010,
      }),
    );

    const first = await auditor.audit(plan, { mutated: true });
    const second = await auditor.audit(plan, { mutated: true });

    expect(first.passed).toBe(true); // inconclusive не блокирует завершение
    expect(first.testRun!.status).toBe("inconclusive");
    expect(first.testNote).toContain("did not finish");
    expect(spy).toHaveBeenCalledTimes(2); // таймаут не кэшируется
  });

  it("invalidates the cache when the tree changes (mtime)", async () => {
    const plan = projectWithTests();
    const spy = vi.spyOn(auditRunners, "runTests").mockResolvedValue(fakeRun());

    await auditor.audit(plan, { mutated: true });
    await auditor.audit(plan, { mutated: true });
    expect(spy).toHaveBeenCalledTimes(1);

    const future = new Date(Date.now() + 5_000);
    utimesSync(testFile, future, future);

    await auditor.audit(plan, { mutated: true });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
