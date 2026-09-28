import { describe, it, expect } from "vitest";
import { createWebUiState, type SseEvent } from "../src/modules/webui/state";
import { makeForwarder } from "../src/modules/webui/forward";
import { planEventFor } from "../src/modules/webui/module";
import type { Plan } from "../src/modules/execution/planner";

function fakeExec(plan: Plan | null): { getActivePlan(): Plan | null } {
  return { getActivePlan: () => plan };
}

const plan: Plan = {
  id: "p1",
  title: "landing",
  createdAt: "2026-09-23T00:00:00.000Z",
  baseDir: ".",
  steps: [
    { id: 1, description: "setup scaffold", status: "done" },
    { id: 2, description: "write landing", status: "in_progress" },
    { id: 3, description: "build", status: "pending" },
  ],
};

describe("webui plan event", () => {
  it("projects a plan/todo tool end into the host snapshot shape", () => {
    expect(planEventFor("plan", fakeExec(plan))).toEqual({
      steps: [
        { text: "setup scaffold", status: "done" },
        { text: "write landing", status: "in_progress" },
        { text: "build", status: "pending" },
      ],
      currentIndex: 1,
    });
    expect(planEventFor("todo", fakeExec(plan))).not.toBeNull();
    expect(planEventFor("plan_step", fakeExec(plan))).not.toBeNull();
  });

  it("does not emit for unrelated tools or a missing plan", () => {
    expect(planEventFor("read_file", fakeExec(plan))).toBeNull();
    expect(planEventFor("plan", fakeExec(null))).toBeNull();
    expect(planEventFor("plan", undefined)).toBeNull();
  });

  it("broadcasts a dedicated plan SSE event via the forwarder", () => {
    const s = createWebUiState();
    const seen: SseEvent[] = [];
    const fwd = makeForwarder(s, (ev) => seen.push(ev));
    const snapshot = planEventFor("plan", fakeExec(plan));
    expect(snapshot).not.toBeNull();
    if (snapshot) fwd.onPlan(snapshot);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: "plan", currentIndex: 1 });
    expect(seen[0].steps).toEqual([
      { text: "setup scaffold", status: "done" },
      { text: "write landing", status: "in_progress" },
      { text: "build", status: "pending" },
    ]);
  });
});
