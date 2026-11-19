import { describe, it, expect, afterAll } from "vitest";
import { rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { registerKillable, unregisterKillable, killByCallId } from "../../src/modules/processes";

const tmp = join(tmpdir(), `mma-runner-${process.pid}.js`);
rmSync(tmp, { force: true });

afterAll(() => {
  try {
    rmSync(tmp, { force: true });
  } catch {
    /* ignore */
  }
});

describe("killByCallId", () => {
  it("invokes a registered kill callback and returns true", () => {
    let killed = false;
    registerKillable("call-1", () => {
      killed = true;
    });
    expect(killByCallId("call-1")).toBe(true);
    expect(killed).toBe(true);
  });

  it("drops the callback after it fires", () => {
    registerKillable("call-2", () => {});
    expect(killByCallId("call-2")).toBe(true);
    expect(killByCallId("call-2")).toBe(false);
  });

  it("unregisterKillable prevents later kills", () => {
    let killed = false;
    registerKillable("call-3", () => {
      killed = true;
    });
    unregisterKillable("call-3");
    expect(killByCallId("call-3")).toBe(false);
    expect(killed).toBe(false);
  });

  it("returns false for an unknown call id", () => {
    expect(killByCallId("no-such-call")).toBe(false);
  });

  it("survives a throwing kill callback", () => {
    registerKillable("call-4", () => {
      throw new Error("boom");
    });
    expect(killByCallId("call-4")).toBe(true);
  });

  it("isolates callbacks by session for colliding call ids", () => {
    let killedA = false;
    let killedB = false;
    registerKillable("call-dup", () => { killedA = true; }, "ses_A");
    registerKillable("call-dup", () => { killedB = true; }, "ses_B");

    expect(killByCallId("call-dup", "ses_A")).toBe(true);
    expect(killedA).toBe(true);
    expect(killedB).toBe(false);
    expect(killByCallId("call-dup", "ses_B")).toBe(true);
    expect(killedB).toBe(true);
  });
});
