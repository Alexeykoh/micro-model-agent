import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Plan } from "../../src/modules/execution/planner";
import {
  readActivePlan,
  formatPlanChecklist,
  stepContextForTool,
  currentStepIndex,
} from "../../src/ui/plan-view";

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: "plan_abc123",
    title: "[3] Check the build",
    steps: [
      { id: 1, description: "Run the build", status: "done" },
      { id: 2, description: "Fix src/app.tsx errors", status: "pending" },
      { id: 3, description: "Delete old dist/js files", status: "pending" },
    ],
    createdAt: "2026-08-17T00:00:00.000Z",
    baseDir: "C:\\proj",
    ...overrides,
  };
}

describe("readActivePlan", () => {
  it("returns null when no active plan exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-plan-"));
    try {
      expect(readActivePlan(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a valid active.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-plan-"));
    try {
      mkdirSync(join(dir, ".mma", "plans"), { recursive: true });
      writeFileSync(join(dir, ".mma", "plans", "active.json"), JSON.stringify(makePlan()), "utf-8");
      const plan = readActivePlan(dir);
      expect(plan).not.toBeNull();
      expect(plan!.id).toBe("plan_abc123");
      expect(plan!.steps).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null on malformed json", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-plan-"));
    try {
      mkdirSync(join(dir, ".mma", "plans"), { recursive: true });
      writeFileSync(join(dir, ".mma", "plans", "active.json"), "{not json", "utf-8");
      expect(readActivePlan(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("formatPlanChecklist", () => {
  it("renders progress, marks and the current step", () => {
    const plan = makePlan();
    const lines = formatPlanChecklist(plan);
    expect(lines[0]).toContain("[plan_abc123]");
    expect(lines[0]).toContain("1/3");
    expect(lines[0]).toContain("33%");
    expect(lines[1]).toContain("[x] 1.");
    expect(lines[2]).toContain("[ ] 2.");
    expect(lines[2]).toContain("Fix src/app.tsx errors");
  });

  it("marks in_progress step with [*] and selects it as current", () => {
    const plan = makePlan();
    plan.steps[1] = { id: 2, description: "Fix src/app.tsx errors", status: "in_progress" };
    expect(currentStepIndex(plan)).toBe(1);
    const lines = formatPlanChecklist(plan);
    expect(lines[2]).toContain("[*] 2.");
  });

  it("returns -1 when all steps are done", () => {
    const plan = makePlan();
    plan.steps.forEach((s) => (s.status = "done"));
    expect(currentStepIndex(plan)).toBe(-1);
  });
});

describe("stepContextForTool", () => {
  it("returns null without a plan", () => {
    expect(stepContextForTool(null, "bash", { command: "bun run build" })).toBeNull();
  });

  it("returns null for structural tools", () => {
    const plan = makePlan();
    for (const tool of ["plan", "todo", "verify", "project_map", "lsp_check"]) {
      expect(stepContextForTool(plan, tool, { action: "show" })).toBeNull();
    }
  });

  it("matches a tool touching the current step's files", () => {
    const plan = makePlan();
    const ctx = stepContextForTool(plan, "edit_file", { path: "src/app.tsx" });
    expect(ctx).toContain("2");
    expect(ctx).toContain("Fix src/app.tsx errors");
  });

  it("falls back to the current step when args carry no files", () => {
    const plan = makePlan();
    const ctx = stepContextForTool(plan, "bash", { command: "bun run build" });
    expect(ctx).toContain("2");
  });

  it("ignores URLs that look like files", () => {
    const plan = makePlan();
    const ctx = stepContextForTool(plan, "web_fetch", {
      url: "https://example.com/page.html",
    });
    expect(ctx).toContain("2");
  });
});
