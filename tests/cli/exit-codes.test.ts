import { describe, it, expect } from "vitest";
import { currentExitCode, fail, resetExitCode, setExitCode } from "../../src/cli/exit-code";
import { getDefaultChannel } from "../../src/output";

/**
 * Код возврата CLI: ошибка команды не должна выглядеть как успех (аудит §7.2/§7.3,
 * план `2026-10-12-harness-module-audit-fixes`, W7/Task 7.6).
 */

describe("код возврата CLI", () => {
  it("defaults to zero", () => {
    resetExitCode();
    expect(currentExitCode()).toBe(0);
  });

  it("fail() sets a non-zero code and prints to stderr", () => {
    resetExitCode();
    const lines: string[] = [];
    const channel = getDefaultChannel();
    const original = channel.writeLine.bind(channel);
    channel.writeLine = (line: string, stream?: string) => {
      lines.push(`${stream ?? "out"}:${line}`);
      return original(line, stream);
    };
    try {
      fail("boom");
    } finally {
      channel.writeLine = original;
    }
    expect(currentExitCode()).toBe(1);
    expect(lines.join("\n")).toContain("boom");
  });

  it("setExitCode records the code", () => {
    resetExitCode();
    setExitCode(2);
    expect(currentExitCode()).toBe(2);
    resetExitCode();
  });
});
