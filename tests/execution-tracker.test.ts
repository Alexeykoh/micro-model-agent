import { describe, it, expect, beforeEach } from "vitest";
import { PlanTracker } from "../src/modules/execution/tracker";
import { PlanCreator } from "../src/modules/execution/planner";

describe("PlanTracker", () => {
  let tracker: PlanTracker;
  let plan: ReturnType<typeof PlanCreator.createPlan>;

  beforeEach(() => {
    plan = PlanCreator.createPlan(
      "test",
      ["step one with text here", "step two with more text", "step three with text"],
      "/test/dir",
    );
    tracker = new PlanTracker(plan);
  });

  it("should start at step 0", () => {
    expect(tracker.getCurrentStepIndex()).toBe(0);
    expect(tracker.getCurrentStep()!.description).toBe("step one with text here");
    expect(tracker.getCurrentStep()!.id).toBe(1);
  });

  it("should update step status", () => {
    tracker.updateStepStatus(1, "done");
    expect(tracker.getStep(1)!.status).toBe("done");
  });

  it("should advance to next step", () => {
    tracker.updateStepStatus(1, "done");
    tracker.advance();
    expect(tracker.getCurrentStepIndex()).toBe(1);
  });

  it("should detect completion", () => {
    tracker.updateStepStatus(1, "done");
    tracker.advance();
    tracker.updateStepStatus(2, "done");
    tracker.advance();
    tracker.updateStepStatus(3, "done");
    expect(tracker.isComplete()).toBe(true);
  });

  it("should provide progress string", () => {
    const progress = tracker.getProgressString();
    expect(progress).toContain("0/3");
  });

  it("should add note to step", () => {
    tracker.addNote(1, "need to check config first");
    expect(tracker.getStep(1)!.note).toContain("check config");
  });

  it("syncCurrentStep should advance past done steps after plan update", () => {
    tracker.updateStepStatus(1, "done");
    tracker.syncCurrentStep();
    expect(tracker.getCurrentStepIndex()).toBe(1);
    expect(tracker.getCurrentStep()!.id).toBe(2);
  });

  it("syncCurrentStep should skip multiple done steps", () => {
    tracker.updateStepStatus(1, "done");
    tracker.updateStepStatus(2, "done");
    tracker.updateStepStatus(3, "done");
    tracker.syncCurrentStep();
    expect(tracker.getCurrentStepIndex()).toBe(2);
    expect(tracker.getCurrentStep()!.id).toBe(3);
  });

  it("syncCurrentStep should not mutate done status to in_progress", () => {
    tracker.updateStepStatus(1, "done");
    tracker.syncCurrentStep();
    expect(tracker.getStep(1)!.status).toBe("done");
    expect(tracker.getStep(2)!.status).toBe("pending");
  });

  it("syncCurrentStep should be a no-op when current step is not done", () => {
    tracker.syncCurrentStep();
    expect(tracker.getCurrentStepIndex()).toBe(0);
    expect(tracker.getCurrentStep()!.id).toBe(1);
  });
});
