import { describe, it, expect } from "vitest";
import { planSnapshotFromModule } from "../src/core/host-plan";

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
