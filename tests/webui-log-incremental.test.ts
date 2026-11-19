import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SessionStore, type SessionLogEntry } from "../src/modules/session/store";

/**
 * Инкрементальное чтение лога: с курсором `since` берётся только хвост
 * (аудит §6.13, план `2026-10-12-harness-module-audit-fixes`, W6/Task 6.6).
 */

let dir: string;
let store: SessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mma-log-tail-"));
  store = new SessionStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function entry(i: number): SessionLogEntry {
  return {
    ts: new Date(1700000000000 + i * 1000).toISOString(),
    type: "llm_usage",
    source: "core",
    content: `event ${i}`,
  } as SessionLogEntry;
}

describe("session log: инкрементальное чтение", () => {
  it("keeps a tail file next to the log", () => {
    store.appendSessionLog("s1", entry(1));
    expect(existsSync(join(dir, "s1", "session.log.tail"))).toBe(true);
  });

  it("reads the tail when a since cursor is given", () => {
    for (let i = 0; i < 5; i++) store.appendSessionLog("s1", entry(i));

    const tail = store.loadSessionLog("s1", { since: new Date(1700000000000).toISOString() });
    expect(tail.length).toBe(5);
    expect(tail[4]?.content).toBe("event 4");
  });

  it("the tail is trimmed to the last lines", () => {
    // 600 строк — больше хвоста (512).
    for (let i = 0; i < 600; i++) store.appendSessionLog("s1", entry(i));
    const tailRaw = readFileSync(join(dir, "s1", "session.log.tail"), "utf-8");
    const tailLines = tailRaw.split("\n").filter(Boolean).length;
    expect(tailLines).toBeLessThanOrEqual(512);
    // Полный лог при этом цел.
    expect(store.loadSessionLog("s1").length).toBe(600);
  });

  it("without a cursor the full log is read", () => {
    for (let i = 0; i < 3; i++) store.appendSessionLog("s1", entry(i));
    expect(store.loadSessionLog("s1").length).toBe(3);
  });

  it("a missing session yields an empty log", () => {
    expect(store.loadSessionLog("ghost")).toEqual([]);
    expect(store.loadSessionLog("ghost", { since: "2024-01-01T00:00:00.000Z" })).toEqual([]);
  });
});
