import { describe, it, expect } from "vitest";
import { shouldEscalate, isHighImpact } from "../src/modules/hitl/escalation";

describe("HITL escalation policy", () => {
  it("low auto-approves only when policy allows", () => {
    expect(shouldEscalate("low", { autoApproveLow: false })).toBe(true);
    expect(shouldEscalate("low", { autoApproveLow: true })).toBe(false);
    expect(shouldEscalate("low", undefined)).toBe(true);
  });

  it("medium/high/critical always escalate", () => {
    expect(shouldEscalate("medium", { autoApproveLow: true })).toBe(true);
    expect(shouldEscalate("high", { autoApproveLow: true })).toBe(true);
    expect(shouldEscalate("critical", { autoApproveLow: true })).toBe(true);
    expect(shouldEscalate(undefined, { autoApproveLow: true })).toBe(true);
  });

  it("high impact detection", () => {
    expect(isHighImpact("high")).toBe(true);
    expect(isHighImpact("critical")).toBe(true);
    expect(isHighImpact("low")).toBe(false);
  });
});
