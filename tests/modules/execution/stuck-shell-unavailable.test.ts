import { describe, it, expect, beforeEach } from "vitest";
import { setLocale } from "../../../src/i18n/index";
import { StuckDetector } from "../../../src/modules/execution/stuck-detector";
import { primaryReason } from "../../../src/modules/execution/stuck-recovery";

beforeEach(() => setLocale("en"));

describe("stuck: shell unavailable (S2)", () => {
  let detector: StuckDetector;

  beforeEach(() => {
    detector = new StuckDetector(5, 3);
  });

  it("raises shell-unavailable at streak 2", () => {
    detector.recordBashAttempt(false, true);
    expect(detector.hasShellUnavailable()).toBe(false);
    detector.recordBashAttempt(false, true);
    expect(detector.hasShellUnavailable()).toBe(true);
  });

  it("outranks tool-errors in the primary reason", () => {
    for (let i = 0; i < 3; i++) detector.recordToolError("bash");
    expect(primaryReason(detector)).toBe("tool-errors");

    detector.recordBashAttempt(false, true);
    detector.recordBashAttempt(false, true);
    expect(primaryReason(detector)).toBe("shell-unavailable");
  });

  it("recovery text points at the file tools", () => {
    detector.recordBashAttempt(false, true);
    detector.recordBashAttempt(false, true);
    const recovery = detector.getRecoveryMessage();
    expect(recovery).toContain("read_file");
    expect(recovery).toContain("glob");
    expect(recovery).toContain("grep");
  });

  it("resets the streak on a successful bash", () => {
    detector.recordBashAttempt(false, true);
    detector.recordBashAttempt(false, true);
    expect(detector.hasShellUnavailable()).toBe(true);

    detector.recordBashAttempt(true);
    expect(detector.hasShellUnavailable()).toBe(false);
    expect(primaryReason(detector)).toBeNull();
  });

  it("classifies as shell_unavailable with the streak count", () => {
    detector.recordBashAttempt(false, true);
    detector.recordBashAttempt(false, true);
    const c = detector.classifyFailure(0);
    expect(c?.type).toBe("shell_unavailable");
    expect(c?.count).toBe(2);
  });

  it("does not count ordinary bash failures as shell-unavailable", () => {
    detector.recordBashAttempt(false);
    detector.recordBashAttempt(false);
    expect(detector.hasShellUnavailable()).toBe(false);
  });
});
