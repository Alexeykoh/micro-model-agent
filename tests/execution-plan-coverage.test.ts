import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  checkPlanCoverage,
  extractFilePaths,
} from "../src/modules/execution/plan-coverage";
import { ExecutionModule } from "../src/modules/execution/module";

function planTool(execModule: ExecutionModule) {
  return execModule.getToolDefinitions().find((t) => t.name === "plan")!;
}

describe("extractFilePaths", () => {
  it("extracts file paths with extensions from a task statement", () => {
    const task = [
      "1. package.json with name micro-utils, exports field",
      "2. src/index.ts — re-exports from string.ts and math.ts",
      "3. src/string.ts — capitalize, camelCase",
    ].join("\n");
    const paths = extractFilePaths(task);
    expect(paths).toEqual(
      expect.arrayContaining([
        "package.json",
        "src/index.ts",
        "string.ts",
        "math.ts",
        "src/string.ts",
      ]),
    );
  });

  it("ignores words without an extension", () => {
    const task = "Create a utility library with tests";
    expect(extractFilePaths(task)).toEqual([]);
  });
});

describe("checkPlanCoverage", () => {
  it("returns no missing when every task path appears in a step", () => {
    const task = "2. src/index.ts — re-exports from string.ts and math.ts";
    const steps = [
      "create src/index.ts with re-exports",
      "create src/string.ts and src/math.ts",
    ];
    const result = checkPlanCoverage(task, steps);
    expect(result.missing).toEqual([]);
  });

  it("flags a task path omitted from all plan steps", () => {
    const task = [
      "2. src/index.ts — re-exports from string.ts and math.ts",
      "3. src/string.ts — capitalize",
    ].join("\n");
    // Model dropped the index.ts step entirely
    const steps = ["create src/string.ts with capitalize"];
    const result = checkPlanCoverage(task, steps);
    expect(result.missing).toContain("src/index.ts");
  });

  it("treats a step mentioning the basename as covered", () => {
    const task = "2. src/index.ts — re-exports";
    const steps = ["create index.ts barrel export"];
    const result = checkPlanCoverage(task, steps);
    expect(result.missing).toEqual([]);
  });

  it("is case insensitive when matching paths", () => {
    const task = "5. src/string.test.ts — tests for each function";
    const steps = ["create src/String.Test.ts tests"];
    const result = checkPlanCoverage(task, steps);
    expect(result.missing).toEqual([]);
  });
});

describe("plan create coverage against history", () => {
  it("does not treat the compacted <system-summary> as the plan task", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "mma-coverage-"));
    const execModule = new ExecutionModule(tmpDir, 8);
    try {
      const tool = planTool(execModule);
      const ctx: any = {
        contextManager: {
          getActiveHistory: () => [
            {
              role: "user",
              content:
                "<system-summary>[Compressed: 10 old turns removed] [Files: bicycle-shop/src/ProductPage.js; bicycle-shop/src/AboutPage.js; bicycle-shop/STATUS.md] [Task: удали js-дубликаты]",
            },
          ],
        },
      };
      const res = await tool.handler(ctx, {
        action: "create",
        title: "T",
        steps: ["Удалить дубликаты .js из src/"],
      });
      expect(res.success).toBe(true);
      expect(res.output).not.toContain("Plan may be missing required files");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});