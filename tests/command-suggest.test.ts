import { describe, it, expect } from "vitest";
import { levenshtein, closestCommand } from "../src/cli/command-suggest";

describe("levenshtein", () => {
  it("is 0 for identical strings", () => {
    expect(levenshtein("session", "session")).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(levenshtein("SESSION", "session")).toBe(0);
  });

  it("counts single substitutions", () => {
    expect(levenshtein("sesion", "session")).toBe(1);
    expect(levenshtein("sessions", "session")).toBe(1);
  });
});

describe("closestCommand", () => {
  const known = ["session", "model", "config", "security", "provider", "help"];

  it("suggests the command for a close typo", () => {
    expect(closestCommand("sesion", known)).toBe("session");
    expect(closestCommand("mdel", known)).toBe("model");
  });

  it("returns undefined when nothing is close", () => {
    expect(closestCommand("explain quantum physics", known)).toBeUndefined();
    expect(closestCommand("xyzzy", known)).toBeUndefined();
  });

  it("returns undefined for an exact match (already a known command)", () => {
    // The caller handles exact matches before asking for a suggestion.
    expect(closestCommand("session", known)).toBe("session");
  });
});
