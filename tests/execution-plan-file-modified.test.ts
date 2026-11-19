import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ExecutionModule } from "../src/modules/execution/module";
import { createTestModule, cleanupTestModule, writeTestFile } from "./plan-test-utils";
import { parseCheck } from "../src/modules/execution/plan-checks";

function planTool(execModule: ExecutionModule) {
  return execModule.getToolDefinitions().find((t) => t.name === "plan")!;
}

describe("parseCheck file-modified", () => {
  it("parses the file-modified prefix", () => {
    expect(parseCheck("file-modified:src/a.ts")).toEqual({ kind: "file-modified", target: "src/a.ts" });
    expect(parseCheck("file-modified:   ")).toBeNull();
  });
});

describe("plan file-modified check", () => {
  let tmpDir: string;
  let execModule: ExecutionModule;

  beforeEach(() => {
    ({ tmpDir, execModule } = createTestModule("mma-file-modified-"));
  });

  afterEach(() => {
    cleanupTestModule(tmpDir);
  });

  it("snapshots the baseline on create and blocks done without an edit", async () => {
    writeTestFile(tmpDir, "src/a.ts", "export const a = 1;\n");
    const tool = planTool(execModule);
    const created = await tool.handler(
      {},
      {
        action: "create",
        title: "T",
        steps: ["Edit src/a.ts: change the export"],
        checks: ["file-modified:src/a.ts"],
      },
    );
    expect(created.success).toBe(true);
    const step = execModule.getTracker()!.getStep(1)!;
    expect(step.checkBaseline).toBeTypeOf("string");

    // Reading the file is not an edit: done must stay blocked (ses_mw7z4mav hole).
    const blocked = await tool.handler({}, { action: "update", step: 1, status: "done" });
    expect(blocked.success).toBe(false);
    expect(blocked.output).toContain("file-modified:src/a.ts");
    expect(execModule.getTracker()!.getStep(1)!.status).not.toBe("done");

    writeTestFile(tmpDir, "src/a.ts", "export const a = 2;\n");
    const ok = await tool.handler({}, { action: "update", step: 1, status: "done" });
    expect(ok.success).toBe(true);
  });

  it("counts creating a missing file as modified", async () => {
    const tool = planTool(execModule);
    await tool.handler(
      {},
      {
        action: "create",
        title: "T",
        steps: ["Create src/new.ts"],
        checks: ["file-modified:src/new.ts"],
      },
    );
    expect(execModule.getTracker()!.getStep(1)!.checkBaseline).toBeNull();

    const blocked = await tool.handler({}, { action: "update", step: 1, status: "done" });
    expect(blocked.success).toBe(false);

    writeTestFile(tmpDir, "src/new.ts", "export const n = 1;\n");
    const ok = await tool.handler({}, { action: "update", step: 1, status: "done" });
    expect(ok.success).toBe(true);
  });

  it("blocks done for a legacy step without a baseline", async () => {
    const tool = planTool(execModule);
    await tool.handler(
      {},
      {
        action: "create",
        title: "T",
        steps: ["Edit src/a.ts"],
        checks: ["file-modified:src/a.ts"],
      },
    );
    // Simulate a plan persisted before the snapshot feature existed.
    const step = execModule.getTracker()!.getStep(1)!;
    delete step.checkBaseline;
    writeTestFile(tmpDir, "src/a.ts", "export const a = 9;\n");

    const blocked = await tool.handler({}, { action: "update", step: 1, status: "done" });
    expect(blocked.success).toBe(false);
    expect(blocked.output).toContain("file-modified:src/a.ts");
  });
});
