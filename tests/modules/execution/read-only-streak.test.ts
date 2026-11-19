/**
 * Read-only стрик-гард: 16 чтений/поисков подряд без единой правки должны давать
 * recovery-директиву «правь или спроси» (сессия ses_mw7z4mav: 64 вызова тулов,
 * 0 правок, diagnose чист — успехи чтений гасили stuck-счётчик).
 */
import { describe, expect, it } from "vitest";
import { StuckDetector } from "../../../src/modules/execution/stuck-detector";

const READ_ONLY = ["read_file", "grep", "glob"];

function streak(sd: StuckDetector, n: number): void {
  for (let i = 0; i < n; i++) {
    sd.recordToolCall(READ_ONLY[i % READ_ONLY.length], { path: `src/f${i}.ts` });
  }
}

describe("read-only streak", () => {
  it("stays quiet below the threshold and fires at 16", () => {
    const sd = new StuckDetector(6, 3, 5);
    streak(sd, 15);
    expect(sd.hasReadOnlyStreak()).toBe(false);
    expect(sd.getRecoveryMessage()).toBe("");
    streak(sd, 1);
    expect(sd.hasReadOnlyStreak()).toBe(true);
    expect(sd.getReadOnlyStreak()).toBe(16);
    expect(sd.getRecoveryMessage()).toContain("edit");
    expect(sd.getStuckReason()).not.toBe("");
    expect(sd.classifyFailure(0)?.type).toBe("read_only_streak");
  });

  it("resets on any non-read-only tool", () => {
    const sd = new StuckDetector(6, 3, 5);
    streak(sd, 16);
    expect(sd.hasReadOnlyStreak()).toBe(true);
    sd.recordToolCall("edit_file", { path: "src/a.ts" });
    expect(sd.hasReadOnlyStreak()).toBe(false);
    expect(sd.getReadOnlyStreak()).toBe(0);
    streak(sd, 16);
    sd.recordToolCall("bash", { command: "bun test" });
    expect(sd.hasReadOnlyStreak()).toBe(false);
    streak(sd, 16);
    sd.recordToolCall("question", { q: "?" });
    expect(sd.hasReadOnlyStreak()).toBe(false);
  });

  it("resets on a new plan step", () => {
    const sd = new StuckDetector(6, 3, 5);
    streak(sd, 16);
    expect(sd.hasReadOnlyStreak()).toBe(true);
    sd.setCurrentStep(2, "next step");
    expect(sd.hasReadOnlyStreak()).toBe(false);
  });
});
