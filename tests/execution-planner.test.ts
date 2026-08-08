import { describe, it, expect } from "vitest";
import { PlanCreator } from "../src/modules/execution/planner";

describe("PlanCreator", () => {
  it("should detect multi-step task by file count", () => {
    expect(PlanCreator.isMultiStep("create src/a.ts and src/b.ts")).toBe(true);
  });

  it("should detect multi-step by word count with action words", () => {
    expect(
      PlanCreator.isMultiStep(
        "implement OAuth authentication with JWT tokens and refresh flow",
      ),
    ).toBe(true);
  });

  it("should return false for simple queries", () => {
    expect(PlanCreator.isMultiStep("what is 2+2?")).toBe(false);
  });

  it("should return false for single file mention", () => {
    expect(PlanCreator.isMultiStep("read src/index.ts")).toBe(false);
  });

  it("should create a plan structure", () => {
    const plan = PlanCreator.createPlan(
      "implement login",
      [
        "Create login route in routes/auth.ts",
        "Create login form component with email and password fields",
      ],
      "/test/dir",
    );
    expect(plan.title).toBe("[2] implement login");
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0].id).toBe(1);
    expect(plan.steps[0].status).toBe("pending");
    expect(plan.id).toMatch(/^plan_/);
    expect(plan.baseDir).toBe("/test/dir");
  });
});
