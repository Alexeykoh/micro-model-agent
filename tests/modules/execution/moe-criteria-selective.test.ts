import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StepVerifier } from "../../../src/modules/execution/verifier";
import { MoEExecutor } from "../../../src/modules/execution/moe-executor";
import type { MoEPlan, SubtaskResult, PlanResult } from "../../../src/modules/execution/types";
import type { AppConfig } from "../../../src/config/types";
import { DEFAULTS } from "../../../src/config/defaults";

function subtask(id: string, overrides?: Partial<MoEPlan["subtasks"][number]>): MoEPlan["subtasks"][number] {
  return {
    id,
    description: `do ${id}`,
    expert_tag: "code",
    allowed_files: [],
    read_only_files: [],
    depends_on: [],
    input_from: [],
    expected_output: "",
    success_criteria: [],
    ...overrides,
  };
}

function makeConfig(): AppConfig {
  const config = JSON.parse(JSON.stringify(DEFAULTS)) as AppConfig;
  config.moe.enabled = true;
  return config;
}

describe("StepVerifier.verifySubtaskCriteria (Plan 5.1)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mma-criteria-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes file-exists when the file is present", async () => {
    writeFileSync(join(dir, "out.txt"), "hello");
    const verifier = new StepVerifier(dir);
    const r = await verifier.verifySubtaskCriteria(
      subtask("a", { success_criteria: ["file-exists:out.txt"] }),
    );
    expect(r.errors).toHaveLength(0);
    expect(r.details[0].passed).toBe(true);
  });

  it("fails file-exists when the file is missing", async () => {
    const verifier = new StepVerifier(dir);
    const r = await verifier.verifySubtaskCriteria(
      subtask("a", { success_criteria: ["file-exists:missing.txt"] }),
    );
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("a");
  });

  it("checks substring-in-file", async () => {
    writeFileSync(join(dir, "code.ts"), "export const MAGIC_VALUE = 42;\n");
    const verifier = new StepVerifier(dir);
    const ok = await verifier.verifySubtaskCriteria(
      subtask("a", { success_criteria: ["substring-in-file:code.ts:MAGIC_VALUE = 42"] }),
    );
    expect(ok.errors).toHaveLength(0);

    const bad = await verifier.verifySubtaskCriteria(
      subtask("a", { success_criteria: ["substring-in-file:code.ts:NOT_PRESENT_XYZ"] }),
    );
    expect(bad.errors).toHaveLength(1);
    expect(bad.errors[0]).toContain("NOT_PRESENT_XYZ");
  });

  it("checks command-exit-0", async () => {
    const verifier = new StepVerifier(dir);
    const ok = await verifier.verifySubtaskCriteria(
      subtask("a", { success_criteria: ["command-exit-0:exit 0"] }),
    );
    expect(ok.errors).toHaveLength(0);

    const bad = await verifier.verifySubtaskCriteria(
      subtask("a", { success_criteria: ["command-exit-0:exit 3"] }),
    );
    expect(bad.errors).toHaveLength(1);
  });

  it("reports LLM-only criteria as warnings, never errors", async () => {
    const verifier = new StepVerifier(dir);
    const r = await verifier.verifySubtaskCriteria(
      subtask("a", { success_criteria: ["the UI looks clean and modern"] }),
    );
    expect(r.errors).toHaveLength(0);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("LLM-only");
  });
});

describe("selective re-plan: executePlan(skipIds/carried) (Plan 5.1)", () => {
  function makeSubagentTool(): any {
    return {
      name: "subagent",
      description: "",
      parameters: { required: [], properties: {} },
      tags: ["file", "code", "shell"],
      handler: async () => ({ success: true, output: "sub ok" }),
    };
  }

  function executor(): MoEExecutor {
    const tool = makeSubagentTool();
    return new MoEExecutor({
      config: makeConfig(),
      toolRegistry: { getAll: () => [tool], get: () => tool } as any,
      toolExecutor: {} as any,
      llmProvider: {} as any,
      logger: { debug: () => {}, warn: () => {}, info: () => {} } as any,
      baseDir: tmpdir(),
    });
  }

  it("skips skipped subtasks and carries their previous results", async () => {
    const moeExecutor = executor();
    const carried: SubtaskResult = {
      subtaskId: "a",
      success: true,
      summary: "ok a",
      result: "a output",
      durationMs: 5,
    };
    const plan: MoEPlan = {
      title: "re-plan",
      subtasks: [subtask("a"), subtask("fix")],
      shared_context: { rules: [], refs: [] },
    };

    const result: PlanResult = await moeExecutor.executePlan(plan, {
      skipIds: new Set(["a"]),
      carriedResults: [carried],
    });

    expect(result.success).toBe(true);
    expect(result.carriedSubtaskIds).toEqual(["a"]);
    const ids = result.results.map((r) => r.subtaskId);
    expect(ids).toContain("a");
    expect(ids).toContain("fix");
    // carried result preserved verbatim
    const carriedEntry = result.results.find((r) => r.subtaskId === "a")!;
    expect(carriedEntry.result).toBe("a output");
  });

  it("resolves dependencies of re-executed subtasks against carried results", async () => {
    const moeExecutor = executor();
    const carried: SubtaskResult = {
      subtaskId: "a",
      success: true,
      summary: "ok a",
      result: "a output",
      durationMs: 5,
    };
    const plan: MoEPlan = {
      title: "re-plan",
      subtasks: [subtask("a"), subtask("b", { depends_on: ["a"] })],
      shared_context: { rules: [], refs: [] },
    };

    const result = await moeExecutor.executePlan(plan, {
      skipIds: new Set(["a"]),
      carriedResults: [carried],
    });

    // "b" must have executed (not silently dropped by topological sort)
    expect(result.results.map((r) => r.subtaskId).sort()).toEqual(["a", "b"]);
    expect(result.success).toBe(true);
  });
});
