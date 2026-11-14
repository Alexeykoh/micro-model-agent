import { describe, expect, it } from "vitest";
import { criticLine, planLines, retractLine, usageLine } from "../src/cli/daemon-repl-render";

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

describe("thin-REPL meta rendering (W9)", () => {
  it("prints the retract label and falls back to the reason", () => {
    expect(retractLine({ label: "draft pulled", reason: "why" })).toBe("draft pulled");
    expect(retractLine({ label: "", reason: "why" })).toBe("why");
    expect(retractLine({})).toBe("");
  });

  it("prints the critic label and falls back to its status", () => {
    expect(criticLine({ label: "critic: success", status: "success" })).toBe("critic: success");
    expect(criticLine({ status: "concern" })).toBe("critic · concern");
    expect(criticLine({})).toBe("");
  });
});
