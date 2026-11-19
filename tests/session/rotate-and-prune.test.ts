import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, appendFileSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SessionStore } from "../../src/modules/session/store";
import { SessionManager } from "../../src/modules/session/manager";
import { SESSION_LOG_MAX_BYTES } from "../../src/modules/session/log-file";
import type { SessionLogEntry } from "../../src/modules/session/store";

/**
 * Сессии: ротация лога, оборванный хвост, prune не трогает живые раннеры,
 * отписка раннера не снимает подписку главного менеджера (аудит §4.14/§7.14/
 * §7.15/§7.16, план `2026-10-12-harness-module-audit-fixes`, W7/Task 7.8).
 */

let dir: string;
let store: SessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mma-sessions-"));
  store = new SessionStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function entry(i: number): SessionLogEntry {
  return {
    ts: new Date(1700000000000 + i).toISOString(),
    type: "llm_usage",
    source: "core",
    content: `event ${i}`,
  } as SessionLogEntry;
}

describe("сессии: лог", () => {
  it("rotates session.jsonl and keeps the tail readable", () => {
    store.saveMeta("s1", {
      id: "s1",
      name: "S1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 0,
    } as never);
    // Пишем крупными записями, пока лог не перевалит порог ротации.
    const chunk = "x".repeat(512 * 1024);
    const writes = Math.ceil(SESSION_LOG_MAX_BYTES / chunk.length) + 2;
    for (let i = 0; i < writes; i++) {
      store.appendSessionLog("s1", { ...entry(i), content: chunk } as SessionLogEntry);
    }
    const logPath = join(dir, "s1", "session.jsonl");
    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(store.loadSessionLog("s1").length).toBeGreaterThan(0);
  });

  it("a torn last line is reported, not silently dropped", () => {
    store.saveMeta("s2", {
      id: "s2",
      name: "S2",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 0,
    } as never);
    store.appendSessionLog("s2", entry(1));
    const logPath = join(dir, "s2", "session.jsonl");
    appendFileSync(logPath, '{"role":"user","content":"tru');

    const r = store.loadSessionLog("s2") as SessionLogEntry[] & { truncatedTail?: boolean };
    expect(r.truncatedTail).toBe(true);
    expect(r.length).toBe(1);
  });
});

describe("сессии: prune и подписки", () => {
  it("pruning skips sessions with live runners", () => {
    const manager = new SessionManager(store, { maxSessions: 1 });
    for (const id of ["s1", "s2"]) {
      store.saveMeta(id, {
        id,
        name: id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 0,
      } as never);
    }
    manager.markBusy("s2", true);
    manager.create("s3");
    expect(manager.get("s2")).not.toBeNull();
  });

  it("unsubscribing one runner does not detach the main manager's rename listener", () => {
    const manager = new SessionManager(store, { maxSessions: 10 });
    store.saveMeta("s1", {
      id: "s1",
      name: "S1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 0,
    } as never);
    let seen = 0;
    manager.onRename(() => {
      seen++;
    });
    const sibling = manager.forkPinned("s1");
    const unsubscribe = sibling.onRename(() => {
      seen++;
    });
    unsubscribe();
    sibling.rename("s1", "renamed");
    expect(seen).toBe(1);
  });
});
