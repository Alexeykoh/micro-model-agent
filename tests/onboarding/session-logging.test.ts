import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SessionStore } from "../../src/modules/session/store";
import { SessionManager } from "../../src/modules/session/manager";
import { SessionLogger } from "../../src/core/session-logger";
import type { SessionLogEntry } from "../../src/modules/session/store";

describe("SessionLogger.logOnboarding", () => {
  let tmpDir: string;
  let manager: SessionManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-onb-"));
    const store = new SessionStore(tmpDir);
    store.init();
    manager = new SessionManager(store, {
      model: "qwen/qwen3.5-9b",
      contextWindow: 32768,
      projectDir: "/test",
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function readLogs(id: string): SessionLogEntry[] {
    const p = join(tmpDir, id, "session.jsonl");
    return readFileSync(p, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as SessionLogEntry);
  }

  it("writes an onboarding_<event> entry with data", () => {
    manager.create("s");
    const id = manager.getActive()!;
    const slog = new SessionLogger(manager, undefined, () => ({ provider: "local", model: "m" }));
    slog.logOnboarding("meet_start", { model: "m" });
    const entry = readLogs(id).find((l) => l.type === "onboarding_meet_start")!;
    expect(entry).toBeTruthy();
    expect(entry.content).toBe("meet_start");
    expect((entry as Record<string, unknown>).model).toBe("m");
    expect(typeof entry.ts).toBe("string");
  });

  it("does not throw without a session", () => {
    const slog = new SessionLogger(undefined, undefined);
    expect(() => slog.logOnboarding("meet_done", {})).not.toThrow();
  });
});
