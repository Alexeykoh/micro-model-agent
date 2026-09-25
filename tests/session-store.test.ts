import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SessionStore } from "../src/modules/session/store";
import type { SessionMeta, SessionMessage } from "../src/modules/session/types";

describe("SessionStore", () => {
  let tmpDir: string;
  let store: SessionStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-session-test-"));
    store = new SessionStore(tmpDir);
    store.init();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should create session directory on init", () => {
    expect(existsSync(tmpDir)).toBe(true);
  });

  it("should save and load meta", () => {
    const meta: SessionMeta = {
      id: "test-001",
      name: "Test Session",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 0,
      model: "qwen/qwen3.5-9b",
      contextWindow: 32768,
      projectDir: "/some/project",
    };
    store.saveMeta("test-001", meta);
    const loaded = store.loadMeta("test-001");
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe("test-001");
    expect(loaded!.name).toBe("Test Session");
    expect(loaded!.projectDir).toBe("/some/project");
  });

  it("should return null for non-existent meta", () => {
    const loaded = store.loadMeta("nonexistent");
    expect(loaded).toBeNull();
  });

  it("should append and load history messages", () => {
    const msg1: SessionMessage = {
      role: "user",
      content: "hello",
      timestamp: new Date().toISOString(),
    };
    const msg2: SessionMessage = {
      role: "assistant",
      content: "hi there",
      timestamp: new Date().toISOString(),
    };
    store.appendMessage("test-002", msg1);
    store.appendMessage("test-002", msg2);
    const history = store.loadHistory("test-002");
    expect(history).toHaveLength(2);
    expect(history[0].content).toBe("hello");
    expect(history[1].content).toBe("hi there");
  });

  it("should return empty array for session with no history", () => {
    expect(store.loadHistory("empty-session")).toEqual([]);
  });

  it("should list sessions", () => {
    const meta1: SessionMeta = {
      id: "s1",
      name: "S1",
      createdAt: "",
      updatedAt: "",
      messageCount: 0,
      model: "",
      contextWindow: 0,
      projectDir: "",
    };
    const meta2: SessionMeta = {
      id: "s2",
      name: "S2",
      createdAt: "",
      updatedAt: "",
      messageCount: 0,
      model: "",
      contextWindow: 0,
      projectDir: "",
    };
    store.saveMeta("s1", meta1);
    store.saveMeta("s2", meta2);
    const list = store.listSessions();
    expect(list).toHaveLength(2);
    const ids = list.map((m) => m.id).sort();
    expect(ids).toEqual(["s1", "s2"]);
  });

  it("should delete a session", () => {
    store.saveMeta("to-delete", {
      id: "to-delete",
      name: "",
      createdAt: "",
      updatedAt: "",
      messageCount: 0,
      model: "",
      contextWindow: 0,
      projectDir: "",
    });
    store.appendMessage("to-delete", { role: "user", content: "x", timestamp: "" });
    expect(store.sessionExists("to-delete")).toBe(true);
    store.deleteSession("to-delete");
    expect(store.sessionExists("to-delete")).toBe(false);
    expect(store.loadMeta("to-delete")).toBeNull();
  });

  it("should check session existence", () => {
    expect(store.sessionExists("ghost")).toBe(false);
    store.saveMeta("exists", {
      id: "exists",
      name: "",
      createdAt: "",
      updatedAt: "",
      messageCount: 0,
      model: "",
      contextWindow: 0,
      projectDir: "",
    });
    expect(store.sessionExists("exists")).toBe(true);
  });

  it("should handle concurrent message appends", () => {
    const msg: SessionMessage = { role: "user", content: "line1", timestamp: "" };
    for (let i = 0; i < 100; i++) {
      store.appendMessage("concurrent", msg);
    }
    const history = store.loadHistory("concurrent");
    expect(history).toHaveLength(100);
  });

  it("should update meta after appending messages", () => {
    store.saveMeta("counter", {
      id: "counter",
      name: "",
      createdAt: "",
      updatedAt: "",
      messageCount: 0,
      model: "m1",
      contextWindow: 1000,
      projectDir: "",
    });
    for (let i = 0; i < 5; i++) {
      store.appendMessage("counter", { role: "user", content: `msg${i}`, timestamp: "" });
    }
    const meta = store.loadMeta("counter");
    expect(meta!.messageCount).toBe(5);
  });

  it("appendMessage should re-read meta from disk, not the stale cache", () => {
    // Simulate another process appending a message (meta.json on disk is
    // ahead of our in-memory cache) — the increment must build on disk state.
    const meta: SessionMeta = {
      id: "ext-counter",
      name: "",
      createdAt: "",
      updatedAt: "",
      messageCount: 7,
      model: "m1",
      contextWindow: 1000,
      projectDir: "",
    };
    store.saveMeta("ext-counter", meta);
    // Corrupt the cache to a stale snapshot (as if another process advanced
    // meta.json after we cached it).
    (store as any)._metaCache.set("ext-counter", { ...meta, messageCount: 2 });
    store.appendMessage("ext-counter", { role: "user", content: "x", timestamp: "" });
    // Cache bypassed → counter continues from disk value 7, not 2.
    const raw = JSON.parse(readFileSync(join(tmpDir, "ext-counter", "meta.json"), "utf-8"));
    expect(raw.messageCount).toBe(8);
  });

  describe("rotateOldSessions", () => {
    function saveOldSession(id: string): void {
      const old = new Date();
      old.setDate(old.getDate() - 40);
      store.saveMeta(id, {
        id,
        name: id,
        createdAt: old.toISOString(),
        updatedAt: old.toISOString(),
        messageCount: 12,
        model: "m1",
        contextWindow: 1000,
        projectDir: "",
      });
      store.appendMessage(id, { role: "user", content: "old msg", timestamp: old.toISOString() });
    }

    it("marks rotated sessions in meta (messageCount zeroed)", () => {
      saveOldSession("old-1");
      // Fresh session with current date — should NOT be rotated
      store.saveMeta("fresh-1", {
        id: "fresh-1",
        name: "fresh-1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 5,
        model: "m1",
        contextWindow: 1000,
        projectDir: "",
      });
      store.appendMessage("fresh-1", { role: "user", content: "recent msg", timestamp: "" });
      store.rotateOldSessions();
      const rotated = store.loadMeta("old-1")!;
      expect(existsSync(join(tmpDir, "old-1.jsonl.gz"))).toBe(true);
      expect(existsSync(join(tmpDir, "old-1", "history.jsonl"))).toBe(false);
      expect(rotated.rotated).toBe(true);
      expect(rotated.messageCount).toBe(0);
      // Fresh session untouched
      const fresh = store.loadMeta("fresh-1")!;
      expect(fresh.rotated).toBeUndefined();
      expect(fresh.messageCount).toBeGreaterThan(0);
    });
  });
});
