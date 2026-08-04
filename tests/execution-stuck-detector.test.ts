import { describe, it, expect, beforeEach } from "vitest";
import { StuckDetector } from "../src/modules/execution/stuck-detector";

describe("StuckDetector", () => {
  let detector: StuckDetector;

  beforeEach(() => {
    detector = new StuckDetector(5, 3);
  });

  it("should not trigger initially", () => {
    expect(detector.isStuck()).toBe(false);
  });

  it("should trigger after threshold iterations without step change", () => {
    for (let i = 0; i < 6; i++) {
      detector.recordIteration(1);
    }
    expect(detector.isStuck()).toBe(true);
  });

  it("should reset on step change", () => {
    for (let i = 0; i < 4; i++) detector.recordIteration(1);
    detector.recordIteration(2);
    expect(detector.isStuck()).toBe(false);
  });

  it("should not reset counter when setCurrentStep repeats the same step", () => {
    for (let i = 0; i < 6; i++) {
      detector.setCurrentStep(1, "step one");
      detector.recordIteration(1);
    }
    expect(detector.isStuck()).toBe(true);
  });

  it("should reset counter when setCurrentStep moves to a new step", () => {
    for (let i = 0; i < 5; i++) {
      detector.setCurrentStep(1, "step one");
      detector.recordIteration(1);
    }
    detector.setCurrentStep(2, "step two");
    detector.recordIteration(2);
    expect(detector.isStuck()).toBe(false);
  });

  it("should detect repetitive tool errors", () => {
    for (let i = 0; i < 4; i++) {
      detector.recordToolError("bash");
    }
    expect(detector.hasRepetitiveErrors("bash")).toBe(true);
  });

  it("should detect off-track tool usage", () => {
    detector.setCurrentStep(2, "create src/routes/oauth.ts");
    const result = detector.checkOffTrack("edit", {
      name: "edit_file",
      arguments: { path: "src/utils/logger.ts" },
    });
    expect(result).toBeDefined();
    if (result) {
      expect(result).toContain("OFF PLAN");
    }
  });

  it("should allow on-track tool usage", () => {
    detector.setCurrentStep(2, "create src/routes/oauth.ts");
    const result = detector.checkOffTrack("edit", {
      name: "edit_file",
      arguments: { path: "src/routes/oauth.ts" },
    });
    expect(result).toBeNull();
  });

  it("should return recovery message when stuck", () => {
    for (let i = 0; i < 6; i++) {
      detector.recordIteration(1);
    }
    expect(detector.isStuck()).toBe(true);
    const recovery = detector.getRecoveryMessage();
    expect(recovery).toBeTruthy();
    expect(recovery).toContain("STUCK");
  });

  it("should return empty recovery message when not stuck", () => {
    detector.recordIteration(1);
    expect(detector.isStuck()).toBe(false);
    expect(detector.getRecoveryMessage()).toBe("");
  });

  it("should return recovery message for repetitive tool errors", () => {
    for (let i = 0; i < 4; i++) {
      detector.recordToolError("bash");
    }
    const recovery = detector.getRecoveryMessage();
    expect(recovery).toBeTruthy();
    expect(recovery).toContain("bash");
  });
});
