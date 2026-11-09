// Durable interrupt (P1 HITL): interrupt.json round-trip.
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SessionStore } from "../../src/modules/session/store";
import { saveInterruptFile, loadInterruptFile } from "../../src/modules/session/interrupt";

describe("durable interrupt", () => {
  it("round-trips paused state", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-interrupt-"));
    expect(loadInterruptFile(dir)).toBeNull();
    saveInterruptFile(dir, { paused: true, pausedAt: new Date().toISOString() });
    expect(loadInterruptFile(dir)?.paused).toBe(true);
    saveInterruptFile(dir, { paused: false });
    expect(loadInterruptFile(dir)?.paused).toBe(false);
  });

  it("store save/load round-trip per session", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-interrupt-"));
    const store = new SessionStore(dir);
    store.saveInterrupt("ses_1", { paused: true, pausedAt: "2026-11-09T00:00:00Z" });
    expect(store.loadInterrupt("ses_1")?.paused).toBe(true);
    expect(store.loadInterrupt("ses_none")).toBeNull();
  });
});
