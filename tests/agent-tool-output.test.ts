import { describe, it, expect } from "vitest";
import { toolOutputCharLimit } from "../src/core/agent";

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
