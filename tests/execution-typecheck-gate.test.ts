import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ExecutionModule } from "../src/modules/execution/module";
import {
  parseBrokenFile,
  extractBrokenFiles,
  stepTypecheckGate,
  createExecutionPlugin,
  type ExecutionPluginState,
} from "../src/modules/execution/execution-plugin";
import { StuckDetector } from "../src/modules/execution/stuck-detector";

function planTool(execModule: ExecutionModule) {
  return execModule.getToolDefinitions().find((t) => t.name === "plan")!;
}

describe("parseBrokenFile", () => {
  it("parses a tsc error line", () => {
    expect(
      parseBrokenFile("src/index.tsx(17,15): error TS2322: Type 'string' is not assignable"),
    ).toBe("src/index.tsx");
  });

  it("parses a bun build error line (relative)", () => {
    expect(parseBrokenFile("src/App.tsx:5:3: error: Expected ';'")).toBe("src/App.tsx");
  });

  it("parses a Windows path with drive letter", () => {
    expect(parseBrokenFile("C:\\proj\\src\\App.tsx:1:2: error: Unexpected token")).toBe(
      "C:/proj/src/App.tsx",
    );
  });

  it("returns null for a line with no file anchor", () => {
    expect(parseBrokenFile('error: Could not resolve "./styles.css"')).toBeNull();
  });
});

describe("extractBrokenFiles", () => {
  it("extracts the file from a typecheck-failed marker", () => {
    const output = [
      "Wrote src/index.tsx",
      "",
      "[Project typecheck failed]: src/index.tsx(17,15): error TS2322: Type 'string' is not assignable to type 'number'.",
    ].join("\n");
    const broken = extractBrokenFiles(output);
    expect(broken).toHaveLength(1);
    expect(broken[0].file).toBe("src/index.tsx");
    expect(broken[0].error).toContain("error TS2322");
  });

  it("extracts the file from a syntax-check marker", () => {
    const broken = extractBrokenFiles(
      "[Syntax check failed]: src/App.tsx:5:3: error: Expected ';'",
    );
    expect(broken[0].file).toBe("src/App.tsx");
  });

  it("records a project-wide failure when the error has no file anchor", () => {
    const broken = extractBrokenFiles('[Project typecheck failed]: error: Could not resolve "./x"');
    expect(broken[0].file).toBe("");
  });

  it("ignores non-marker lines (diffs, plain output)", () => {
    expect(extractBrokenFiles("-old\n+new\nindex.tsx(1,1): error TS1: fake")).toHaveLength(0);
  });
});

describe("stepTypecheckGate", () => {
  it("allows done with no known failures", () => {
    expect(stepTypecheckGate(new Map(), "Create src/app.tsx")).toBeNull();
  });

  it("blocks a project-wide failure", () => {
    const err = 'error: Could not resolve "./styles.css"';
    const res = stepTypecheckGate(new Map([["", err]]), "Create src/app.tsx");
    expect(res).toBe(err);
  });

  it("blocks a step whose named file fails the check", () => {
    const err = "src/index.tsx(17,15): error TS2322: mismatch";
    const res = stepTypecheckGate(new Map([["src/index.tsx", err]]), "Fix src/index.tsx");
    expect(res).toBe(err);
  });

  it("matches a nested file path (token suffix match)", () => {
    const err = "bicycle-shop/src/index.tsx(1,1): error TS1005: Expected ';'";
    const res = stepTypecheckGate(
      new Map([["bicycle-shop/src/index.tsx", err]]),
      "Update src/index.tsx styles",
    );
    expect(res).toBe(err);
  });

  it("normalizes Windows backslashes before matching", () => {
    const err = "C:\\proj\\src\\App.tsx:1:2: error: Unexpected token";
    const res = stepTypecheckGate(new Map([["C:/proj/src/App.tsx", err]]), "Edit src/App.tsx");
    expect(res).toBe(err);
  });

  it("does not block a step whose files are unrelated to the failure", () => {
    expect(
      stepTypecheckGate(
        new Map([["src/other.ts", "src/other.ts(1,1): error TS1: x"]]),
        "Create src/app.tsx",
      ),
    ).toBeNull();
  });

  it("does not block a step that names no files (cannot blame it)", () => {
    expect(
      stepTypecheckGate(new Map([["src/app.tsx", "src/app.tsx(1,1): error TS1: x"]]), "Run build"),
    ).toBeNull();
  });
});

describe("plan update typecheck gate (integration)", () => {
  let tmpDir: string;
  let execModule: ExecutionModule;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-tc-gate-"));
    execModule = new ExecutionModule(tmpDir, 8);
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  function failures(): Map<string, string> {
    return (execModule as any).state.typecheckFailures;
  }

  it("blocks marking done while the step's file is still broken", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await tool.handler(ctx, {
      action: "create",
      title: "T",
      steps: ["Create src/app.tsx with a component"],
    });
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "app.tsx"), "export const App = () => null;\n");

    failures().set("src/app.tsx", "src/app.tsx(1,1): error TS1005: Expected ';'");
    const res = await tool.handler(ctx, { action: "update", step: 1, status: "done" });
    expect(res.success).toBe(false);
    expect(res.output).toContain("TS1005");
    expect(execModule.getTracker()!.getStep(1)!.status).not.toBe("done");
  });

  it("allows done once the failure is cleared (clean write)", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await tool.handler(ctx, {
      action: "create",
      title: "T",
      steps: ["Create src/app.tsx with a component"],
    });
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "app.tsx"), "export const App = () => null;\n");

    failures().set("src/app.tsx", "src/app.tsx(1,1): error TS1005");
    failures().clear();
    const res = await tool.handler(ctx, { action: "update", step: 1, status: "done" });
    expect(res.success).toBe(true);
    // Single-step plan is auto-archived on completion — the tracker clears.
    expect(execModule.getTracker()).toBeNull();
  });

  it("allows done when the failure is in an unrelated file", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await tool.handler(ctx, {
      action: "create",
      title: "T",
      steps: ["Create src/app.tsx with a component"],
    });
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "app.tsx"), "export const App = () => null;\n");

    failures().set("src/other.ts", "src/other.ts(1,1): error TS1: x");
    const res = await tool.handler(ctx, { action: "update", step: 1, status: "done" });
    expect(res.success).toBe(true);
  });
});

describe("execution plugin typecheck failure tracking", () => {
  function makePlugin() {
    const stuckDetector = new StuckDetector(6, 3, 5);
    const state: ExecutionPluginState = {
      lastRecoveryIteration: -5,
      consecutivePlanWarnings: 0,
      lastStepId: -1,
      stuckNotified: false,
      depsGateHints: new Map(),
      mutationsWithoutPlan: 0,
      planNudgeSent: false,
      typecheckFailures: new Map<string, string>(),
    };
    const plugin = createExecutionPlugin({
      stuckDetector,
      trackerRef: { current: null },
      pendingMessages: [],
      forbiddenBashFailures: new Map(),
      state,
      checkPlanAlignment: () => null,
      advancePlanIfStepComplete: () => {},
      maybeSearchError: () => {},
    });
    return { plugin, state };
  }

  it("records the broken file from a write result", async () => {
    const { plugin, state } = makePlugin();
    await plugin.onAfterTool?.(
      {},
      { id: "c1", name: "write_file", arguments: { path: "src/app.tsx" } },
      { success: true, output: "[Project typecheck failed]: src/app.tsx(1,1): error TS1005: X" },
    );
    expect(state.typecheckFailures.get("src/app.tsx")).toContain("error TS1005");
  });

  it("clears failures on a clean write result", async () => {
    const { plugin, state } = makePlugin();
    state.typecheckFailures.set("src/app.tsx", "old");
    await plugin.onAfterTool?.(
      {},
      { id: "c2", name: "edit_file", arguments: { path: "src/app.tsx" } },
      { success: true, output: "Replaced in src/app.tsx" },
    );
    expect(state.typecheckFailures.size).toBe(0);
  });

  it("keeps failures when a failed result carries no marker", async () => {
    const { plugin, state } = makePlugin();
    state.typecheckFailures.set("src/app.tsx", "old");
    await plugin.onAfterTool?.(
      {},
      { id: "c1", name: "write_file", arguments: { path: "src/app.tsx" } },
      { success: false, output: "[SECURITY BLOCKED]" },
    );
    expect(state.typecheckFailures.get("src/app.tsx")).toBe("old");
  });
});
