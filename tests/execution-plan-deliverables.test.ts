import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { ExecutionModule } from "../src/modules/execution/module";
import { createTestPlan, createTestModule, cleanupTestModule, writeTestFile } from "./plan-test-utils";

function planTool(execModule: ExecutionModule) {
  return execModule.getToolDefinitions().find((t) => t.name === "plan")!;
}

describe("plan update deliverable gate", () => {
  let tmpDir: string;
  let execModule: ExecutionModule;

  beforeEach(() => {
    ({ tmpDir, execModule } = createTestModule("mma-plan-deliv-"));
  });

  afterEach(() => {
    cleanupTestModule(tmpDir);
  });

  it("blocks marking a step done when its named file does not exist", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};

    const created = await createTestPlan(execModule, "T", ["Create src/bicycles.ts with content"]);
    expect(created.success).toBe(true);

    const res = await tool.handler(ctx, {
      action: "update",
      step: 1,
      status: "done",
    });
    expect(res.success).toBe(false);
    expect(res.output).toContain("bicycles.ts");
    expect(execModule.getTracker()!.getStep(1)!.status).not.toBe("done");
  });

  it("blocks marking done when the file was just deleted", async () => {
    // Regression (ses_msstxxff): `del bicycles.ts` then
    // `plan update step=2 status=done` while the file was gone — the step
    // was self-certified and the audit gate passed.
    const tool = planTool(execModule);
    const ctx: any = {};
    await createTestPlan(execModule, "T", ["Download images", "Replace emoji in bicycles.ts with links"]);
    await tool.handler(ctx, { action: "update", step: 1, status: "done" });

    writeTestFile(tmpDir, "src/bicycles.ts", "export const x = 1;\n");
    rmSync(join(tmpDir, "src", "bicycles.ts"));

    const res = await tool.handler(ctx, {
      action: "update",
      step: 2,
      status: "done",
    });
    expect(res.success).toBe(false);
    expect(execModule.getTracker()!.getStep(2)!.status).not.toBe("done");
  });

  it("allows marking done once the named file exists (even nested)", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await createTestPlan(execModule, "T", ["Create src/bicycles.ts", "Update readme"]);

    // File lives in a nested project dir relative to baseDir.
    mkdirSync(join(tmpDir, "bicycle-shop", "src"), { recursive: true });
    writeFileSync(join(tmpDir, "bicycle-shop", "src", "bicycles.ts"), "export const x = 1;\n");

    const res = await tool.handler(ctx, {
      action: "update",
      step: 1,
      status: "done",
    });
    expect(res.success).toBe(true);
    expect(execModule.getTracker()!.getStep(1)!.status).toBe("done");
  });

  it("allows marking done when a step has no file tokens (pure command)", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await createTestPlan(execModule, "T", ["Run bun build and verify no errors"]);
    const res = await tool.handler(ctx, {
      action: "update",
      step: 1,
      status: "done",
    });
    expect(res.success).toBe(true);
  });

  it("stays silent on file-less steps in a pure non-code plan (ses_mukulpsv_is271g)", async () => {
    // A bicycle-recommendation plan has no file steps at all — the
    // vacuous-gate note must not fire on any of them (previously every
    // done step got "names no files … run build/tests", pushing the
    // model to materialize profile/recommendation .md files).
    const tool = planTool(execModule);
    const ctx: any = {};
    await createTestPlan(execModule, "T", [
      "Ask the user about budget and size",
      "Compare three bicycle models on the web",
    ]);
    const res = await tool.handler(ctx, { action: "update", step: 1, status: "done" });
    expect(res.success).toBe(true);
    expect(res.output).not.toContain("no files");
    expect(res.output).not.toContain("не называет файлов");
  });

  it("neutral note on file-less steps in a mixed plan never asks for files", async () => {
    // When the plan DOES contain file steps, the note still fires on the
    // file-less step — but must not suggest adding file paths or running
    // build/tests unconditionally.
    const tool = planTool(execModule);
    const ctx: any = {};
    await createTestPlan(execModule, "T", ["Create src/a.ts", "Summarize the change for the user"]);
    writeTestFile(tmpDir, "src/a.ts", "export const a = 1;\n");
    const res = await tool.handler(ctx, { action: "update", step: 1, status: "done" });
    expect(res.success).toBe(true);
    const res2 = await tool.handler(ctx, { action: "update", step: 2, status: "done" });
    expect(res2.success).toBe(true);
    expect(res2.output).toContain("do NOT create files");
  });

  it("does not treat URL hostnames as missing deliverables", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await createTestPlan(execModule, "T", ["Add git remote https://example.com/repo.git"]);
    const res = await tool.handler(ctx, {
      action: "update",
      step: 1,
      status: "done",
    });
    expect(res.success).toBe(true);
  });

  it("still enforces the order gate before the deliverable gate", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await createTestPlan(execModule, "T", ["Create src/a.ts", "Create src/b.ts"]);

    const res = await tool.handler(ctx, {
      action: "update",
      step: 2,
      status: "done",
    });
    expect(res.success).toBe(false);
    expect(res.output).not.toContain("deliverables");
    expect(execModule.getTracker()!.getStep(2)!.status).not.toBe("done");
  });

  it("keeps blocking done when the named file does not exist (strict gate)", async () => {
    // The deliverable gate must NOT become fuzzy (no plural/singular or
    // substring matching). A step naming a non-existent file stays blocked;
    // the documented escape hatch is status=skipped.
    const tool = planTool(execModule);
    const ctx: any = {};
    await createTestPlan(execModule, "T", ["Create src/type.ts with the Bicycle type"]);
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    // Real file has a different name — gate must still refuse.
    writeFileSync(join(tmpDir, "src", "types.ts"), "export interface Bicycle {}\n");
    const res = await tool.handler(ctx, {
      action: "update",
      step: 1,
      status: "done",
    });
    expect(res.success).toBe(false);
    expect(execModule.getTracker()!.getStep(1)!.status).not.toBe("done");
  });

  it("allows marking a delete-kind step done once its files are gone", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await tool.handler(ctx, {
      action: "create",
      title: "T",
      steps: ["Remove src/AboutPage.js", "Update readme"],
      checks: ["file-exists:src/AboutPage.js", "manual:verify Update readme"],
      kinds: ["delete", "create"],
    });
    expect(execModule.getTracker()!.getStep(1)!.kind).toBe("delete");

    // File still exists → blocked.
    writeTestFile(tmpDir, "src/AboutPage.js", "x");
    const blocked = await tool.handler(ctx, {
      action: "update",
      step: 1,
      status: "done",
    });
    expect(blocked.success).toBe(false);
    expect(blocked.output).toContain("AboutPage.js");
    expect(execModule.getTracker()!.getStep(1)!.status).not.toBe("done");

    // File gone → done accepted.
    rmSync(join(tmpDir, "src", "AboutPage.js"));
    const ok = await tool.handler(ctx, {
      action: "update",
      step: 1,
      status: "done",
    });
    expect(ok.success).toBe(true);
    expect(execModule.getTracker()!.getStep(1)!.status).toBe("done");
  });

  it("rejects an invalid kinds value", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    const res = await tool.handler(ctx, {
      action: "create",
      title: "T",
      steps: ["Remove src/a.js"],
      checks: ["file-exists:src/a.js"],
      kinds: ["explode"],
    });
    expect(res.success).toBe(false);
  });

  it("still blocks done when a create-kind file was just deleted (regression ses_msstxxff)", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await createTestPlan(execModule, "T", ["Replace emoji in bicycles.ts"]);
    writeTestFile(tmpDir, "src/bicycles.ts", "export const x = 1;\n");
    rmSync(join(tmpDir, "src", "bicycles.ts"));
    const res = await tool.handler(ctx, {
      action: "update",
      step: 1,
      status: "done",
    });
    expect(res.success).toBe(false);
  });

  it("rejects a non-array kinds value", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    const res = await tool.handler(ctx, {
      action: "create",
      title: "T",
      steps: ["Remove src/a.js"],
      checks: ["file-exists:src/a.js"],
      kinds: "delete",
    });
    expect(res.success).toBe(false);
  });

  it("blocks a delete-kind step when only one of several files still exists", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await tool.handler(ctx, {
      action: "create",
      title: "T",
      steps: ["Remove src/a.js and src/b.js"],
      checks: ["file-exists:src/a.js"],
      kinds: ["delete"],
    });
    writeTestFile(tmpDir, "src/a.js", "x");
    const res = await tool.handler(ctx, {
      action: "update",
      step: 1,
      status: "done",
    });
    expect(res.success).toBe(false);
    expect(res.output).toContain("a.js");
  });

  it("rejects steps[] rewrite via update, while create keeps kinds", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await createTestPlan(execModule, "T", ["Create src/x.ts"]);
    writeTestFile(tmpDir, "src/x.ts", "x");
    // Changing the plan's steps via `update` is refused (use re-plan/create).
    const rejected = await tool.handler(ctx, {
      action: "update",
      title: "T2",
      steps: ["Remove src/x.ts"],
      checks: ["file-exists:src/x.ts"],
      kinds: ["delete"],
    });
    expect(rejected.success).toBe(false);
    expect(rejected.output).toContain("re-plan");
    // Rebuilding through `create` (no progress yet) keeps the declared kinds.
    const res = await tool.handler(ctx, {
      action: "create",
      title: "T2",
      steps: ["Remove src/x.ts"],
      checks: ["file-exists:src/x.ts"],
      kinds: ["delete"],
    });
    expect(res.success).toBe(true);
    expect(execModule.getTracker()!.getStep(1)!.kind).toBe("delete");
    // Still blocked while the file exists (delete semantics kept).
    const blocked = await tool.handler(ctx, { action: "update", step: 1, status: "done" });
    expect(blocked.success).toBe(false);
    expect(blocked.output).toContain("x.ts");
    // Gone → done accepted.
    rmSync(join(tmpDir, "src", "x.ts"));
    const ok = await tool.handler(ctx, { action: "update", step: 1, status: "done" });
    expect(ok.success).toBe(true);
  });

  it("auto-advances a delete-kind step only once its files are gone (inversion of create-kind)", async () => {
    // advancePlanIfStepComplete fires on write/edit success, which the plan
    // tool handler does not trigger — drive it through the public plugin
    // hook, not a private method.
    const tool = planTool(execModule);
    const ctx: any = {};
    await tool.handler(ctx, {
      action: "create",
      title: "T",
      steps: ["Remove src/old.js", "Update readme"],
      checks: ["file-exists:src/old.js", "manual:verify Update readme"],
      kinds: ["delete", "create"],
    });
    const plugin = execModule.getPlugin();
    writeTestFile(tmpDir, "src/old.js", "x");
    const fakeCall: any = { name: "edit_file", arguments: { path: "src/old.js" } };
    // File still exists → a successful write/edit must NOT auto-advance
    // (create-kind semantics inverted for delete).
    plugin.onAfterTool({}, fakeCall, { success: true, output: "ok" });
    expect(execModule.getTracker()!.getStep(1)!.status).not.toBe("done");
    // File gone → the same write/edit signal auto-advances.
    rmSync(join(tmpDir, "src", "old.js"));
    plugin.onAfterTool({}, fakeCall, { success: true, output: "ok" });
    expect(execModule.getTracker()!.getStep(1)!.status).toBe("done");
  });

  it("auto-advance ignores extension-only tokens so a delete step cannot skip past live files", async () => {
    // Regression (0.36 branch): advancePlanIfStepComplete extracted step file
    // tokens with the raw \b[\w./\\-]+\.[a-z]+ regex, so a description like
    // "Удалить все .js дубликаты, оставить только .tsx/.ts" produced the phantom
    // token "tsx/.ts" (from ".tsx/.ts") which never exists — allGone was
    // trivially true and the delete step auto-advanced on the next successful
    // write even while the real files to delete (src/dup.js) still existed.
    // The shared extractFileLikeTokens rejects extension-only segments, so
    // the step stays pending while the real file is on disk.
    const tool = planTool(execModule);
    const ctx: any = {};
    await tool.handler(ctx, {
      action: "create",
      title: "T",
      steps: ["Удалить все .js дубликаты, оставить только .tsx/.ts", "Update readme"],
      checks: ["manual:verify Удалить все .js дубликаты, оставить только .tsx/.ts", "manual:verify Update readme"],
      kinds: ["delete", "create"],
    });
    const plugin = execModule.getPlugin();
    writeTestFile(tmpDir, "src/dup.js", "x");

    const ctx2: any = {
      contextManager: { addMessage: () => {} },
      sessionLog: { plan: () => {} },
    };
    const call: any = { name: "write_file", arguments: { path: "src/other.ts" } };
    const result: any = { success: true, output: "Written src/other.ts" };

    // Real file still present → a successful write must NOT auto-advance the
    // delete step (the extension-only token must be filtered out).
    plugin.onAfterTool(ctx2, call, result);
    expect(execModule.getTracker()!.getStep(1)!.status).not.toBe("done");

    // With no concrete file token left in the description, auto-advance has
    // nothing to verify and stays pending even after the real file is gone
    // (the phantom tsx/.ts is filtered out, not resolved to a live path).
    rmSync(join(tmpDir, "src", "dup.js"));
    plugin.onAfterTool(ctx2, call, result);
    expect(execModule.getTracker()!.getStep(1)!.status).not.toBe("done");

    // The step is still completable explicitly: with no named deliverables
    // left, the delete gate is vacuous and plan update accepts done.
    const ok = await tool.handler(ctx, { action: "update", step: 1, status: "done" });
    expect(ok.success).toBe(true);
    expect(execModule.getTracker()!.getStep(1)!.status).toBe("done");
  });

  it("auto-switches kind to delete when all named files are gone and model says done", async () => {
    // Regression (session test scenario 9): model calls `plan update step=N
    // status=done` after deleting files. The step has kind=create (default),
    // so the deliverable gate blocks done (file not found) and the agent
    // loops. The fix: when ALL named files are gone AND the agent tracked
    // them as deleted (via ConsistencyCheck), auto-switch kind to delete.
    const deletedFiles = new Set<string>(["src/old.ts"]);
    execModule.setHallucinationDetector({
      getConsistencyCheck: () =>
        ({
          getDeletedFiles: () => Array.from(deletedFiles),
        }) as any,
    } as any);
    // Get tool AFTER setting the detector — handler closes over deps
    const tool = planTool(execModule);
    const ctx: any = {};
    await createTestPlan(execModule, "T", ["Remove src/old.ts"]);
    writeTestFile(tmpDir, "src/old.ts", "export const x = 1;\n");
    // After plan create without explicit kinds, kind defaults to "create"
    expect(execModule.getTracker()!.getStep(1)!.kind).toBe("create");

    // Simulate the agent deleting the file
    rmSync(join(tmpDir, "src", "old.ts"));

    // Now mark done — kind should auto-switch to delete
    const res = await tool.handler(ctx, { action: "update", step: 1, status: "done" });
    expect(res.success).toBe(true);
    // Plan auto-archives after the last step → tracker is null
    expect(execModule.getTracker()).toBeNull();
    // Verify the plan was archived with kind=delete
    const archived = execModule
      .getStore()
      .listArchived()
      .find((p) => p.steps[0]?.kind === "delete");
    expect(archived).toBeDefined();
    expect(archived!.steps[0].kind).toBe("delete");
  });

  it("does NOT auto-switch kind when files are missing but never tracked as deleted", async () => {
    // When files are missing but the agent never ran delete_file on them,
    // auto-switch should NOT fire — the model must create the files.
    const tool = planTool(execModule);
    const ctx: any = {};
    await createTestPlan(execModule, "T", ["Create src/missing.ts"]);
    // No file created, no delete tracked
    const res = await tool.handler(ctx, { action: "update", step: 1, status: "done" });
    expect(res.success).toBe(false);
    expect(res.output).toContain("missing.ts");
    expect(execModule.getTracker()!.getStep(1)!.kind).toBe("create");
  });
});

describe("auto-advance after non-file tools", () => {
  let tmpDir: string;
  let execModule: ExecutionModule;

  beforeEach(() => {
    ({ tmpDir, execModule } = createTestModule("mma-auto-adv-"));
  });

  afterEach(() => {
    cleanupTestModule(tmpDir);
  });

  function pluginCtx() {
    return {
      contextManager: { addMessage: () => {} },
      sessionLog: { plan: () => {} },
    } as any;
  }

  it("auto-advances the current step after a successful bash call created its file", async () => {
    // Regression (certification 3.5/3.8): small models often create files
    // via bash (echo/heredoc) instead of write_file. Auto-advance only
    // fired after write_file/edit_file, so the plan stayed stuck at 1/4
    // and 4/5 even though every deliverable existed on disk.
    const plugin = execModule.getPlugin();
    await planTool(execModule).handler({} as any, {
      action: "create",
      title: "T",
      steps: ["Create data/output.json with results", "Run verification"],
      checks: ["file-exists:data/output.json", "manual:verify Run verification"],
    });
    mkdirSync(join(tmpDir, "data"), { recursive: true });
    writeFileSync(join(tmpDir, "data", "output.json"), '{"filtered": [60, 70]}');

    const bashCall: any = { name: "bash", arguments: { command: "echo done" } };
    const okResult: any = { success: true, output: "done" };

    plugin.onAfterTool(pluginCtx(), bashCall, okResult);
    expect(execModule.getTracker()!.getStep(1)!.status).toBe("done");
    expect(execModule.getTracker()!.getCurrentStepIndex()).toBe(1);

    // A FAILED bash call must not advance anything.
    plugin.onAfterTool(
      pluginCtx(),
      { name: "bash", arguments: { command: "bun run process.ts" } } as any,
      { success: false, output: "error" } as any,
    );
    expect(execModule.getTracker()!.getStep(2)!.status).not.toBe("done");
  });

  it("auto-advance after a non-file tool is a no-op when deliverables are missing", async () => {
    const plugin = execModule.getPlugin();
    await planTool(execModule).handler({} as any, {
      action: "create",
      title: "T",
      steps: ["Create src/never-written.ts"],
      checks: ["file-exists:src/never-written.ts"],
    });
    plugin.onAfterTool(
      pluginCtx(),
      { name: "bash", arguments: { command: "ls" } } as any,
      { success: true, output: "" } as any,
    );
    expect(execModule.getTracker()!.getStep(1)!.status).not.toBe("done");
  });

  it("does NOT auto-advance from a read-only tool even when the target file exists", async () => {
    // An "Update X" step whose file already exists from an earlier step must
    // never be completed by a successful read/glob — only a mutating tool
    // (write/edit/bash/…) may trigger the deliverable re-check.
    const plugin = execModule.getPlugin();
    await planTool(execModule).handler({} as any, {
      action: "create",
      title: "T",
      steps: ["Update src/config.json with new settings"],
      checks: ["file-exists:src/config.json"],
    });
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "config.json"), '{"debug": false}');

    for (const name of ["read_file", "glob", "grep", "list_dir"]) {
      plugin.onAfterTool(
        pluginCtx(),
        { name, arguments: { path: "src/config.json" } } as any,
        { success: true, output: "content" } as any,
      );
      expect(execModule.getTracker()!.getStep(1)!.status).not.toBe("done");
    }
  });
});

describe("plan create guard", () => {
  let tmpDir: string;
  let execModule: ExecutionModule;

  beforeEach(() => {
    ({ tmpDir, execModule } = createTestModule("mma-plan-guard-"));
  });

  afterEach(() => {
    cleanupTestModule(tmpDir);
  });

  it("blocks create when the active plan has progress (resume, don't restart)", async () => {
    // Regression (ses_msvuao0h): right after compaction the model called
    // `plan create` again, silently discarding the 1/6 plan into drafts.
    const tool = planTool(execModule);
    const ctx: any = {};
    await createTestPlan(execModule, "T", ["Create src/a.ts", "Create src/b.ts"]);
    writeTestFile(tmpDir, "src/a.ts", "export const a = 1;\n");
    const done = await tool.handler(ctx, { action: "update", step: 1, status: "done" });
    expect(done.success).toBe(true);
    // Plan not complete yet (step 2 pending) — tracker still active.
    expect(execModule.getTracker()).not.toBeNull();

    const firstPlanId = execModule.getTracker()!.getPlan().id;
    const res = await tool.handler(ctx, {
      action: "create",
      title: "T2",
      steps: ["Create src/c.ts"],
      checks: ["file-exists:src/c.ts"],
    });
    expect(res.success).toBe(false);
    expect(res.output).toContain(firstPlanId);
    expect(res.output).toContain("current: step");
    // The in-progress plan must remain active — nothing was replaced.
    expect(execModule.getTracker()!.getPlan().id).toBe(firstPlanId);
  });

  it("allows create over a fresh active plan with no progress, noting it", async () => {
await createTestPlan(execModule, "T", ["Create src/a.ts"]);
    const res = await createTestPlan(execModule, "T2", ["Create src/b.ts"]);
    expect(res.success).toBe(true);
    expect(res.output).toContain("preserved as a draft");
  });

  it("notes that a provided plan id is ignored (ids are auto-generated)", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    const res = await tool.handler(ctx, {
      action: "create",
      title: "T",
      steps: ["Create src/a.ts"],
      checks: ["file-exists:src/a.ts"],
      id: "plan_error_check_e07pb2",
    });
    expect(res.success).toBe(true);
    expect(res.output).toContain("auto-generated");
  });
});
