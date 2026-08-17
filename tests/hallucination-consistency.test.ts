import { describe, it, expect } from "vitest";
import { ConsistencyCheck } from "../src/modules/hallucination/consistency";

describe("ConsistencyCheck", () => {
  it("should track decisions", () => {
    const check = new ConsistencyCheck();
    check.trackDecision("use express", "src/index.ts");
    expect(check.getDecisions()).toHaveLength(1);
    expect(check.getDecisions()[0]).toEqual({
      decision: "use express",
      location: "src/index.ts",
    });
  });

  it("should track created files", () => {
    const check = new ConsistencyCheck();
    check.trackCreatedFile("a.ts");
    expect(check.getCreatedFiles()).toContain("a.ts");
  });

  it("should track deleted files", () => {
    const check = new ConsistencyCheck();
    check.trackDeletedFile("old.ts");
    expect(check.getDeletedFiles()).toContain("old.ts");
  });

  it("hasDecisions is false when empty", () => {
    const check = new ConsistencyCheck();
    expect(check.hasDecisions()).toBe(false);
    check.trackDecision("use vitest", "agent");
    expect(check.hasDecisions()).toBe(true);
  });
});
