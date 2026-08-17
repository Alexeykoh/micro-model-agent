import { describe, it, expect } from "vitest";
import { PlanCreator } from "../src/modules/execution/planner";

describe("PlanCreator", () => {
  it("should detect multi-step task by file count", () => {
    expect(PlanCreator.isMultiStep("create src/a.ts and src/b.ts")).toBe(true);
  });

  it("should detect multi-step by word count with action words", () => {
    expect(
      PlanCreator.isMultiStep("implement OAuth authentication with JWT tokens and refresh flow"),
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

describe("PlanCreator.replan", () => {
  it("should keep done steps and replace pending steps", () => {
    const plan = PlanCreator.createPlan(
      "replan test",
      ["create src/a.ts", "create src/b.ts", "create src/c.ts"],
      "/test/dir",
    );
    plan.steps[0].status = "done";
    plan.steps[1].status = "pending";

    const replanned = PlanCreator.replan(plan, ["run tests", "deploy app"]);
    expect(replanned.steps).toHaveLength(3); // 1 done + 2 new
    expect(replanned.steps[0].id).toBe(1);
    expect(replanned.steps[0].status).toBe("done");
    expect(replanned.steps[0].description).toBe("create src/a.ts");
    expect(replanned.steps[1].id).toBe(2);
    expect(replanned.steps[1].status).toBe("pending");
    expect(replanned.steps[1].description).toBe("run tests");
    expect(replanned.steps[2].id).toBe(3);
    expect(replanned.steps[2].status).toBe("pending");
    expect(replanned.steps[2].description).toBe("deploy app");
  });

  it("should keep skipped steps", () => {
    const plan = PlanCreator.createPlan("test", ["step A", "step B", "step C"], "/test/dir");
    plan.steps[0].status = "done";
    plan.steps[1].status = "skipped";

    const replanned = PlanCreator.replan(plan, ["step D"]);
    expect(replanned.steps).toHaveLength(3); // 1 done + 1 skipped + 1 new
    expect(replanned.steps[0].status).toBe("done");
    expect(replanned.steps[1].status).toBe("skipped");
    expect(replanned.steps[2].status).toBe("pending");
    expect(replanned.steps[2].description).toBe("step D");
  });

  it("should use custom title when provided", () => {
    const plan = PlanCreator.createPlan("original", ["step A", "step B"], "/test/dir");
    plan.steps[0].status = "done";
    const replanned = PlanCreator.replan(plan, ["step C"], "New Direction");
    expect(replanned.title).toContain("New Direction");
  });

  it("should preserve original title when no custom title", () => {
    const plan = PlanCreator.createPlan("original", ["step A", "step B"], "/test/dir");
    plan.steps[0].status = "done";
    const replanned = PlanCreator.replan(plan, ["step C"]);
    expect(replanned.title).toContain("original");
  });

  it("should preserve baseDir and id", () => {
    const plan = PlanCreator.createPlan("test", ["step A"], "/test/dir");
    const replanned = PlanCreator.replan(plan, ["step B"]);
    expect(replanned.baseDir).toBe("/test/dir");
    expect(replanned.id).toBe(plan.id);
  });

  it("should handle replan when all steps are done", () => {
    const plan = PlanCreator.createPlan("test", ["step A"], "/test/dir");
    plan.steps[0].status = "done";
    const replanned = PlanCreator.replan(plan, ["step B", "step C"]);
    expect(replanned.steps).toHaveLength(3);
    expect(replanned.steps[0].status).toBe("done");
    expect(replanned.steps[1].description).toBe("step B");
    expect(replanned.steps[2].description).toBe("step C");
  });
});
