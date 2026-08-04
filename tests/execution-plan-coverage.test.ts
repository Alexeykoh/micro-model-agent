import { describe, it, expect } from "vitest";
import {
  checkPlanCoverage,
  extractFilePaths,
} from "../src/modules/execution/plan-coverage";

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