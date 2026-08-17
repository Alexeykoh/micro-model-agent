import { describe, it, expect } from "vitest";
import {
  validatePlan,
  expertTagsExist,
  hasCycle,
  hasAllowedFilesOverlap,
  deleteReadOverlap,
  applyAutoFixes,
} from "../../../src/modules/execution/plan-validator";
import type { MoEPlan } from "../../../src/modules/execution/types";
import { DEFAULTS } from "../../../src/config/defaults";

const validPlan: MoEPlan = {
  title: "Test Plan",
  subtasks: [
    {
      id: "task-1",
      description: "Create file",
      expert_tag: "code",
      allowed_files: ["src/test.ts"],
      read_only_files: [],
      depends_on: [],
      input_from: [],
      expected_output: "file created",
      success_criteria: ["file exists"],
    },
    {
      id: "task-2",
      description: "Read file",
      expert_tag: "code",
      allowed_files: [],
      read_only_files: ["src/test.ts"],
      depends_on: ["task-1"],
      input_from: [],
      expected_output: "file read",
      success_criteria: ["content returned"],
    },
  ],
  shared_context: { rules: [], refs: [] },
};

describe("validatePlan", () => {
  it("passes for a valid plan", () => {
    const result = validatePlan(validPlan, DEFAULTS);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects plan with no subtasks", () => {
    const empty = { ...validPlan, subtasks: [] };
    const result = validatePlan(empty, DEFAULTS);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("no subtasks");
  });
});

describe("expertTagsExist", () => {
  it("passes for known expert tag", () => {
    const errors = expertTagsExist(validPlan.subtasks, DEFAULTS);
    expect(errors).toHaveLength(0);
  });

  it("rejects unknown expert tag", () => {
    const subtasks = [{ ...validPlan.subtasks[0], expert_tag: "nonexistent" }];
    const errors = expertTagsExist(subtasks, DEFAULTS);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("nonexistent");
  });
});

describe("hasCycle", () => {
  it("passes for acyclic graph", () => {
    const errors = hasCycle(validPlan.subtasks);
    expect(errors).toHaveLength(0);
  });

  it("detects direct cycle", () => {
    const subtasks = [
      { ...validPlan.subtasks[0], id: "a", depends_on: ["b"] },
      { ...validPlan.subtasks[0], id: "b", depends_on: ["a"] },
    ];
    const errors = hasCycle(subtasks);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("Cycle");
  });

  it("detects indirect cycle", () => {
    const subtasks = [
      { ...validPlan.subtasks[0], id: "a", depends_on: ["b"] },
      { ...validPlan.subtasks[0], id: "b", depends_on: ["c"] },
      { ...validPlan.subtasks[0], id: "c", depends_on: ["a"] },
    ];
    const errors = hasCycle(subtasks);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("passes for self-loop (single node depends on itself)", () => {
    const subtasks = [{ ...validPlan.subtasks[0], id: "a", depends_on: ["a"] }];
    const errors = hasCycle(subtasks);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("hasAllowedFilesOverlap", () => {
  it("passes for non-overlapping files", () => {
    const errors = hasAllowedFilesOverlap(validPlan.subtasks);
    expect(errors).toHaveLength(0);
  });

  it("detects write-write overlap", () => {
    const subtasks = [
      { ...validPlan.subtasks[0], id: "a", allowed_files: ["src/shared.ts"], depends_on: [] },
      { ...validPlan.subtasks[0], id: "b", allowed_files: ["src/shared.ts"], depends_on: [] },
    ];
    const errors = hasAllowedFilesOverlap(subtasks);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("Write-write overlap");
  });

  it("allows write-write overlap with dependency chain", () => {
    const subtasks = [
      { ...validPlan.subtasks[0], id: "a", allowed_files: ["src/shared.ts"], depends_on: [] },
      { ...validPlan.subtasks[0], id: "b", allowed_files: ["src/shared.ts"], depends_on: ["a"] },
    ];
    const errors = hasAllowedFilesOverlap(subtasks);
    expect(errors).toHaveLength(0);
  });
});

describe("deleteReadOverlap", () => {
  it("detects read-after-write without dependency", () => {
    const subtasks = [
      {
        ...validPlan.subtasks[0],
        id: "writer",
        allowed_files: ["src/output.ts"],
        read_only_files: [],
        depends_on: [],
      },
      {
        ...validPlan.subtasks[0],
        id: "reader",
        allowed_files: [],
        read_only_files: ["src/output.ts"],
        depends_on: [],
      },
    ];
    const results = deleteReadOverlap(subtasks);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].canAutoFix).toBe(true);
    expect(results[0].subtaskId).toBe("reader");
  });

  it("does not flag when dependency already exists", () => {
    const subtasks = [
      {
        ...validPlan.subtasks[0],
        id: "writer",
        allowed_files: ["src/output.ts"],
        read_only_files: [],
        depends_on: [],
      },
      {
        ...validPlan.subtasks[0],
        id: "reader",
        allowed_files: [],
        read_only_files: ["src/output.ts"],
        depends_on: ["writer"],
      },
    ];
    const results = deleteReadOverlap(subtasks);
    expect(results).toHaveLength(0);
  });
});

describe("applyAutoFixes", () => {
  it("adds depends_on for auto-fixable issues", () => {
    const plan: MoEPlan = {
      title: "fix",
      subtasks: [
        {
          id: "a",
          description: "",
          expert_tag: "code",
          allowed_files: [],
          read_only_files: [],
          depends_on: [],
          input_from: [],
          expected_output: "",
          success_criteria: [],
        },
      ],
      shared_context: { rules: [], refs: [] },
    };
    const fixed = applyAutoFixes(plan, [{ subtaskId: "a", fix: "Add depends_on: b" }]);
    expect(fixed.subtasks[0].depends_on).toContain("b");
  });
});
