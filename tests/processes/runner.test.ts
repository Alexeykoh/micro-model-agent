import { describe, it, expect, afterAll } from "vitest";
import { writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runCommand, killByCallId } from "../../src/modules/processes";

const longRunningScript = join(tmpdir(), `mma-runner-${process.pid}.js`);
writeFileSync(
  longRunningScript,
  `setInterval(() => {}, 1000);`,
  "utf-8",
);

afterAll(() => {
  try {
    rmSync(longRunningScript, { force: true });
  } catch {
    /* ignore */
  }
});

describe("runCommand", () => {
  it("returns stdout and exit code for a successful command", async () => {
    const res = await runCommand("node -p 21+21");
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe("42");
    expect(res.timedOut).toBe(false);
  });

  it("returns a non-zero exit code for a failing command", async () => {
    const res = await runCommand("node -e \"process.exit(3)\"");
    expect(res.code).toBe(3);
    expect(res.success).toBeUndefined();
  });

  it("captures stderr", async () => {
    const res = await runCommand("node -e \"console.error('boom')\"");
    expect(res.stderr).toContain("boom");
  });

  it("kills a long-running command on timeout", async () => {
    const start = Date.now();
    const res = await runCommand(`node ${longRunningScript}`, {
      timeoutMs: 300,
    });
    const elapsed = Date.now() - start;
    expect(res.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(5000);
  });

  it("kills a long-running command via killByCallId", async () => {
    const promise = runCommand(`node ${longRunningScript}`, {
      callId: "test-call-1",
    });
    // give the child a moment to spawn
    await new Promise((r) => setTimeout(r, 250));
    const killed = killByCallId("test-call-1");
    expect(killed).toBe(true);
    const res = await promise;
    expect(res.timedOut).toBe(false);
    // the script never exits naturally — a non-zero code means it was killed
    expect(res.code).not.toBe(0);
  });

  it("killByCallId returns false for unknown call id", () => {
    expect(killByCallId("no-such-call")).toBe(false);
  });
});
