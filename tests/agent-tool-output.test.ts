import { describe, it, expect } from "vitest";
import { toolOutputCharLimit, compactToolError } from "../src/core/agent";

describe("toolOutputCharLimit", () => {
  it("never truncates a tool that declares boundedOutput regardless of remaining budget", () => {
    // Near-full context (remaining 2245 of 24577): a bounded read tool must
    // NOT be cut to ~2K chars — the model then believes files are truncated
    // and loops re-reading them (ses_mssx0k11).
    expect(toolOutputCharLimit(2245, 24577, true)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("still truncates unbounded tools by budget", () => {
    const limit = toolOutputCharLimit(2245, 24577, false);
    expect(limit).toBeLessThan(24577 * 0.3 * 2);
    expect(limit).toBeGreaterThan(0);
  });
});

describe("compactToolError", () => {
  it("returns only the first non-empty line", () => {
    const output = "Error: file not found\n\nHint: run list_dir first\nDo NOT retry.";
    expect(compactToolError(output)).toBe("Error: file not found");
  });

  it("skips leading blank lines", () => {
    expect(compactToolError("\n\n  boom  \ntail")).toBe("boom");
  });

  it("truncates long lines", () => {
    const out = compactToolError("x".repeat(500), 40);
    expect(out.length).toBe(40);
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns empty string for empty/nullish output", () => {
    expect(compactToolError("")).toBe("");
    expect(compactToolError(undefined)).toBe("");
    expect(compactToolError("\n  \n")).toBe("");
  });
});
