import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { formatCrashEntry, writeCrashEntry, CRASH_LOG_FILE } from "../src/core/crash-handler";

describe("crash handler", () => {
  it("formats a crash entry from an Error", () => {
    const entry = formatCrashEntry("uncaughtException", new Error("boom"));
    expect(entry.type).toBe("uncaughtException");
    expect(entry.message).toBe("boom");
    expect(entry.stack).toContain("boom");
    expect(entry.environment.mmaVersion).toMatch(/\d+\.\d+\.\d+/);
    expect(typeof entry.ts).toBe("string");
  });

  it("formats a crash entry from a non-Error reason", () => {
    const entry = formatCrashEntry("unhandledRejection", "some reason");
    expect(entry.message).toBe("some reason");
    expect(entry.stack).toBe("some reason");
  });

  it("sanitizes secrets out of crash messages", () => {
    const entry = formatCrashEntry("uncaughtException", new Error("boom with sk-abcdefghijklmnopqrstuvwxyz123456"));
    expect(entry.message).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(entry.message).toContain("sk-[REDACTED]");
  });

  it("appends entries to crash.jsonl", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-crash-"));
    try {
      writeCrashEntry(dir, formatCrashEntry("uncaughtException", new Error("boom")));
      writeCrashEntry(dir, formatCrashEntry("unhandledRejection", "reason"));
      const lines = readFileSync(join(dir, CRASH_LOG_FILE), "utf-8").trim().split("\n");
      expect(lines).toHaveLength(2);
      const first = JSON.parse(lines[0]);
      expect(first.type).toBe("uncaughtException");
      expect(first.environment).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes to nested/non-existent dirs", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "mma-crash-")), "nested", "deep");
    try {
      writeCrashEntry(dir, formatCrashEntry("uncaughtException", new Error("x")));
      expect(readFileSync(join(dir, CRASH_LOG_FILE), "utf-8")).toContain("x");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});