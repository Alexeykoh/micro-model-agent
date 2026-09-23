import { describe, it, expect } from "vitest";
import { planSnapshotFromModule, adaptActivePlan } from "../src/core/host-plan";
import type { Plan, PlanStep } from "../src/modules/execution/planner";

function planWith(steps: PlanStep[]): Plan {
  return {
    id: "plan_test01",
    title: "[3] test plan",
    steps,
    createdAt: "2026-09-23T00:00:00.000Z",
    baseDir: "E:/projects/micro-models-agent",
  };
}

describe("host plan snapshot", () => {
  it("maps an active plan to a HostStateSnapshot plan", () => {
    const snap = planSnapshotFromModule({
      steps: [
        { text: "setup", status: "done" },
        { text: "build", status: "in_progress" },
        { text: "ship", status: "pending" },
      ],
      currentIndex: 1,
    });
    expect(snap).toEqual({
      steps: [
        { text: "setup", status: "done" },
        { text: "build", status: "in_progress" },
        { text: "ship", status: "pending" },
      ],
      currentIndex: 1,
    });
  });

  it("returns null for a missing plan", () => {
    expect(planSnapshotFromModule(null)).toBeNull();
  });
});

describe("adaptActivePlan", () => {
  it("returns null for a missing plan", () => {
    expect(adaptActivePlan(null)).toBeNull();
    expect(adaptActivePlan(undefined)).toBeNull();
  });

  it("maps description to text and keeps statuses", () => {
    const adapted = adaptActivePlan(
      planWith([
        { id: 1, description: "setup", status: "done" },
        { id: 2, description: "build", status: "in_progress" },
        { id: 3, description: "ship", status: "pending" },
      ]),
    );
    expect(adapted).toEqual({
      steps: [
        { text: "setup", status: "done" },
        { text: "build", status: "in_progress" },
        { text: "ship", status: "pending" },
      ],
      currentIndex: 1,
    });
  });

  it("maps skipped to done", () => {
    const adapted = adaptActivePlan(
      planWith([{ id: 1, description: "optional", status: "skipped" }]),
    );
    expect(adapted?.steps).toEqual([{ text: "optional", status: "done" }]);
  });

  it("keeps in_progress as in_progress", () => {
    const adapted = adaptActivePlan(
      planWith([{ id: 1, description: "work", status: "in_progress" }]),
    );
    expect(adapted?.steps[0].status).toBe("in_progress");
  });

  it("yields currentIndex -1 when all steps are settled", () => {
    const adapted = adaptActivePlan(
      planWith([
        { id: 1, description: "a", status: "done" },
        { id: 2, description: "b", status: "skipped" },
      ]),
    );
    expect(adapted?.currentIndex).toBe(-1);
  });

  it("points currentIndex at the first non-settled step", () => {
    const adapted = adaptActivePlan(
      planWith([
        { id: 1, description: "a", status: "done" },
        { id: 2, description: "b", status: "skipped" },
        { id: 3, description: "c", status: "pending" },
        { id: 4, description: "d", status: "failed" },
      ]),
    );
    expect(adapted?.currentIndex).toBe(2);
  });
});
