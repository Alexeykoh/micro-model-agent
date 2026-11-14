import { describe, expect, it } from "vitest";
import { planLines, usageLine } from "../src/cli/daemon-repl-render";

describe("thin-REPL plan/usage rendering (W8)", () => {
  it("renders plan steps with status marks", () => {
    const lines = planLines({
      steps: [
        { text: "read", status: "done" },
        { text: "write", status: "in_progress" },
        { text: "check", status: "pending" },
      ],
    });
    expect(lines).toEqual(["1. ● read", "2. ◐ write", "3. ○ check"]);
    expect(planLines({})).toEqual([]);
  });

  it("prefers cost and falls back to tokens", () => {
    expect(usageLine({ usage: { costUsd: 0.25, promptTokens: 10, completionTokens: 5 } })).toMatch(
      /0\.25|25/,
    );
    expect(usageLine({ usage: { costUsd: 0, promptTokens: 10, completionTokens: 5 } })).toMatch(
      /15/,
    );
    expect(usageLine({})).toBeUndefined();
    expect(usageLine({ usage: {} })).toBeUndefined();
  });
});
