import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MoEExecutor } from "../../../src/modules/execution/moe-executor";
import type { MoEPlan } from "../../../src/modules/execution/types";
import type { ToolRegistry } from "../../../src/tools/registry";
import type { ToolDefinition } from "../../../src/tools/types";

function fakeSubagent(output: string): ToolDefinition {
  return {
    name: "subagent",
    description: "fake",
    parameters: { type: "object", properties: {} },
    tags: ["file"],
    handler: async () => ({ success: true, output }),
  };
}

describe("MoEExecutor with result_mode=file", () => {
  it("attaches full artifact content to SubtaskResult.result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-moe-"));
    try {
      // Fake sub-agent persists its result via ArtifactStore semantics:
      // <baseDir>/.mma/artifacts/moe/<name>.md
      const artifactPath = join(dir, ".mma", "artifacts", "moe", "out.md");
      mkdirSync(join(dir, ".mma", "artifacts", "moe"), { recursive: true });
      writeFileSync(artifactPath, "FULL_ARTIFACT_CONTENT_42", "utf8");

      const registry = {
        get: (name: string) =>
          name === "subagent"
            ? fakeSubagent(
                `Sub-agent completed. Full result saved to artifact: ${artifactPath}\nIterations: 1\nSummary:\nsnip`,
              )
            : undefined,
        getAll: () => [fakeSubagent("")],
      } as unknown as ToolRegistry;

      const executor = new MoEExecutor({
        config: {
          subagent: { resultMode: "file" },
          experts: {
            code: { model: "m", tool_tags: ["file"] },
          },
        } as any,
        toolRegistry: registry,
        toolExecutor: {} as any,
        llmProvider: {} as any,
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
        baseDir: dir,
      });

      const plan: MoEPlan = {
        title: "t",
        subtasks: [
          {
            id: "task-1",
            description: "produce output.md",
            expert_tag: "code",
            allowed_files: [dir],
            read_only_files: [],
            depends_on: [],
            input_from: [],
            expected_output: "output.md",
            success_criteria: ["file exists"],
          },
        ],
        shared_context: { rules: [], refs: [] },
      };

      const planResult = await executor.executePlan(plan);
      expect(planResult.success).toBe(true);
      const sub = planResult.results[0];
      expect(sub.summary).toContain("Artifact:");
      expect(sub.result).toContain("FULL_ARTIFACT_CONTENT_42");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to handler output when no artifact path can be parsed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-moe-"));
    try {
      const registry = {
        get: (name: string) =>
          name === "subagent" ? fakeSubagent("plain text result") : undefined,
        getAll: () => [fakeSubagent("plain text result")],
      } as unknown as ToolRegistry;

      const executor = new MoEExecutor({
        config: {
          subagent: { resultMode: "file" },
          experts: {
            code: { model: "m", tool_tags: ["file"] },
          },
        } as any,
        toolRegistry: registry,
        toolExecutor: {} as any,
        llmProvider: {} as any,
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
        baseDir: dir,
      });

      const plan: MoEPlan = {
        title: "t",
        subtasks: [
          {
            id: "task-1",
            description: "produce output.md",
            expert_tag: "code",
            allowed_files: [],
            read_only_files: [],
            depends_on: [],
            input_from: [],
            expected_output: "output.md",
            success_criteria: ["file exists"],
          },
        ],
        shared_context: { rules: [], refs: [] },
      };

      const planResult = await executor.executePlan(plan);
      expect(planResult.success).toBe(true);
      expect(planResult.results[0].result).toBe("plain text result");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
