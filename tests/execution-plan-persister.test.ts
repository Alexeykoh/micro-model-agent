import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PlanPersister } from "../src/modules/execution/plan-persister";
import { PlanCreator } from "../src/modules/execution/planner";
import { existsSync, readFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dirname, "_test_plan_persister");

describe("PlanPersister", () => {
  let persister: PlanPersister;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    persister = new PlanPersister(TEST_DIR);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("should save and load a plan", () => {
    const plan = PlanCreator.createPlan(
      "Test Plan",
      ["step one with enough length", "step two with enough length"],
      "/test/dir",
    );
    persister.save(plan);

    const loaded = persister.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.title).toBe("[2] Test Plan");
    expect(loaded!.steps).toHaveLength(2);
    expect(loaded!.steps[0].description).toBe("step one with enough length");
    expect(loaded!.id).toMatch(/^plan_/);
    expect(loaded!.baseDir).toBe("/test/dir");
  });

  it("should return null when no plan file exists", () => {
    const emptyPersister = new PlanPersister(join(TEST_DIR, "empty"));
    expect(emptyPersister.load()).toBeNull();
  });

  it("should persist step status changes", () => {
    const plan = PlanCreator.createPlan(
      "Test",
      ["a step with enough chars here", "another step that is long enough"],
      "/test/dir",
    );
    persister.save(plan);

    plan.steps[0].status = "done";
    plan.steps[1].status = "in_progress";
    persister.save(plan);

    const loaded = persister.load();
    expect(loaded!.steps[0].status).toBe("done");
    expect(loaded!.steps[1].status).toBe("in_progress");
  });

  it("should clear the plan file", () => {
    const plan = PlanCreator.createPlan(
      "Test",
      ["a step with enough characters to pass validation"],
      "/test/dir",
    );
    persister.save(plan);
    persister.clear();

    const raw = readFileSync(join(TEST_DIR, ".mma", "plan.json"), "utf-8");
    expect(raw).toBe("");
  });

  it("should include updatedAt timestamp", () => {
    const plan = PlanCreator.createPlan(
      "T",
      ["a step that is at least long enough to be valid"],
      "/test/dir",
    );
    persister.save(plan);

    const raw = JSON.parse(readFileSync(join(TEST_DIR, ".mma", "plan.json"), "utf-8"));
    expect(raw.updatedAt).toBeDefined();
    expect(new Date(raw.updatedAt).getTime()).toBeGreaterThan(0);
  });
});
