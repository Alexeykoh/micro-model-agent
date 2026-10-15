import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SessionStore } from "../src/modules/session/store";
import { SessionManager } from "../src/modules/session/manager";
import type { SessionMessage } from "../src/modules/session/types";

describe("SessionManager", () => {
  let tmpDir: string;
  let store: SessionStore;
  let manager: SessionManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-session-mgr-"));
    store = new SessionStore(tmpDir);
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

  it("should create a session and return meta", () => {
    const meta = manager.create("My Session");
    expect(meta.id).toBeTruthy();
    expect(meta.name).toBe("My Session");
    expect(meta.model).toBe("qwen/qwen3.5-9b");
    expect(meta.contextWindow).toBe(32768);
    expect(meta.messageCount).toBe(0);
  });

  it("should create session with auto-generated name if not provided", () => {
    const meta = manager.create();
    expect(meta.id).toBeTruthy();
    expect(meta.name).toMatch(/^Session \d{4}-\d{2}-\d{2}/);
  });

  it("setEffectiveContext updates the active session's window and model", () => {
    manager.create("S");
    manager.setEffectiveContext(64000, "prism-ml/bonsai-27b");
    const active = manager.getActiveMeta()!;
    expect(active.contextWindow).toBe(64000);
    expect(active.model).toBe("prism-ml/bonsai-27b");
  });

  it("touch bumps updatedAt without touching the message count", () => {
    // Ход, не добавивший сообщений (оборванный MoE), иначе оставлял мету со
    // временем старта сессии — список сессий показывал «мёртвую» дату.
    manager.create("S");
    const before = manager.getActiveMeta()!.updatedAt;
    manager.touch();
    const after = manager.getActiveMeta()!;
    expect(after.messageCount).toBe(0);
    expect(new Date(after.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(before).getTime(),
    );
  });

  it("touch is a no-op without an active session", () => {
    expect(() => manager.touch()).not.toThrow();
  });

  it("should list sessions in reverse chronological order", () => {
    // Явные растущие метки вместо wall-clock: три create подряд укладываются в
    // одну миллисекунду, ничья решается порядком readdir (на ext4 произволен) —
    // и тест флакает только на CI. Время здесь — вход, а не измерение.
    const t1 = "2026-10-15T10:00:00.000Z";
    const t2 = "2026-10-15T10:00:01.000Z";
    const t3 = "2026-10-15T10:00:02.000Z";
    manager.create("First");
    manager.appendMessage({ role: "user", content: "m1", timestamp: t1 });
    manager.create("Second");
    manager.appendMessage({ role: "user", content: "m2", timestamp: t2 });
    manager.create("Third");
    manager.appendMessage({ role: "user", content: "m3", timestamp: t3 });
    const list = manager.list();
    expect(list).toHaveLength(3);
    // Полный порядок детерминирован метками выше — прежнее частичное
    // `[a.id, b.id]` прятало ничью, а не проверяло сортировку.
    expect(list.map((s) => s.name)).toEqual(["Third", "Second", "First"]);
  });

  it("should set and get active session", () => {
    const s1 = manager.create("S1");
    manager.appendMessage({ role: "user", content: "m1", timestamp: new Date().toISOString() });
    const s2 = manager.create("S2");
    expect(manager.getActive()).toBe(s2.id);
    manager.setActive(s1.id);
    expect(manager.getActive()).toBe(s1.id);
    expect(manager.getActiveMeta()?.name).toBe("S1");
  });

  it("should fail to set active to non-existent session", () => {
    expect(() => manager.setActive("ghost")).toThrow("Session not found");
  });

  it("should append message to active session", () => {
    manager.create("Test");
    const msg: SessionMessage = {
      role: "user",
      content: "hello",
      timestamp: new Date().toISOString(),
    };
    manager.appendMessage(msg);
    const history = manager.loadHistory();
    expect(history).toHaveLength(1);
    expect(history[0].content).toBe("hello");
    expect(manager.getActiveMeta()?.messageCount).toBe(1);
  });

  it("should throw on append without active session", () => {
    const msg: SessionMessage = { role: "user", content: "x", timestamp: "" };
    expect(() => manager.appendMessage(msg)).toThrow("No active session");
  });

  it("should delete a session", () => {
    const meta = manager.create("ToDelete");
    expect(manager.get(meta.id)).not.toBeNull();
    manager.delete(meta.id);
    expect(manager.get(meta.id)).toBeNull();
  });

  it("should clear active if deleted session was active", () => {
    const meta = manager.create("Active");
    expect(manager.getActive()).toBe(meta.id);
    manager.delete(meta.id);
    expect(manager.getActive()).toBeNull();
  });

  it("should rename a session", () => {
    const meta = manager.create("Old Name");
    manager.rename(meta.id, "New Name");
    expect(manager.get(meta.id)?.name).toBe("New Name");
  });

  it("onRename fires and is shared with pinned siblings", () => {
    const meta = manager.create("Original");
    const seen: string[] = [];
    const off = manager.onRename((m) => seen.push(m.name));

    manager.rename(meta.id, "Renamed", "auto");
    expect(seen).toEqual(["Renamed"]);

    // Per-session раннер пишет имя через pinned-сиблинг — слушатель общий.
    const pinned = manager.forkPinned(meta.id);
    pinned.rename(meta.id, "Refined", "auto");
    expect(seen).toEqual(["Renamed", "Refined"]);

    off();
    manager.rename(meta.id, "After", "manual");
    expect(seen).toEqual(["Renamed", "Refined"]);
  });

  it("should get session by id", () => {
    const meta = manager.create("Find me");
    const found = manager.get(meta.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(meta.id);
  });

  it("should return null for unknown id", () => {
    expect(manager.get("unknown")).toBeNull();
  });

  it("should enforce max sessions limit", () => {
    const limitedManager = new SessionManager(store, {
      model: "m1",
      contextWindow: 1000,
      projectDir: "/p",
      maxSessions: 2,
    });
    limitedManager.create("S1");
    limitedManager.appendMessage({ role: "user", content: "m1", timestamp: new Date().toISOString() });
    limitedManager.create("S2");
    limitedManager.appendMessage({ role: "user", content: "m2", timestamp: new Date().toISOString() });
    limitedManager.create("S3");
    const list = limitedManager.list();
    expect(list).toHaveLength(2);
  });

  it("should load history when setting active", () => {
    const s1 = manager.create("S1");
    manager.appendMessage({ role: "user", content: "msg1", timestamp: "" });
    const s2 = manager.create("S2");
    manager.appendMessage({ role: "user", content: "msg2", timestamp: "" });
    manager.setActive(s1.id);
    const history = manager.loadHistory();
    expect(history).toHaveLength(1);
    expect(history[0].content).toBe("msg1");
  });

  it("marks explicit create(name) as manual and default create() as default", () => {
    const store = new SessionStore(tmpDir);
    const mgr = new SessionManager(store, { model: "m", contextWindow: 1000, projectDir: tmpDir });
    const auto = mgr.create();
    expect(auto.nameSource).toBe("default");
    const named = mgr.create("My name");
    expect(named.nameSource).toBe("manual");
  });

  it("rename records the requested source (default manual)", () => {
    const store = new SessionStore(tmpDir);
    const mgr = new SessionManager(store, { model: "m", contextWindow: 1000, projectDir: tmpDir });
    const s = mgr.create();
    mgr.rename(s.id, "auto title", "auto");
    expect(mgr.get(s.id)!.nameSource).toBe("auto");
    mgr.rename(s.id, "user title");
    expect(mgr.get(s.id)!.nameSource).toBe("manual");
  });

  it("pruneEmpty removes sessions without user messages and keeps the rest", () => {
    // Seed via the store: stage several coexisting empty sessions without
    // create() touching them (create no longer auto-prunes).
    const now = new Date().toISOString();
    const mk = (id: string, name: string) => ({
      id,
      name,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      model: "m",
      contextWindow: 1000,
      projectDir: "/test",
    });
    store.saveMeta("empty1", mk("empty1", "Empty"));
    store.saveMeta("real1", mk("real1", "Real"));
    store.appendMessage("real1", { role: "user", content: "hi", timestamp: now });
    store.saveMeta("fresh1", mk("fresh1", "Fresh"));
    const deleted = manager.pruneEmpty("fresh1");
    expect(deleted).toContain("empty1");
    expect(deleted).not.toContain("real1");
    expect(deleted).not.toContain("fresh1");
    expect(manager.get("empty1")).toBeNull();
    expect(manager.get("real1")).not.toBeNull();
  });

  it("create does not auto-prune other empty sessions (web tabs coexist)", () => {
    const stale = manager.create("Stale");
    const fresh = manager.create("Fresh");
    expect(manager.get(stale.id)).not.toBeNull();
    expect(manager.get(fresh.id)).not.toBeNull();
  });

  it("pruneEmpty treats assistant-only and whitespace user text as empty", () => {
    const now = new Date().toISOString();
    const mk = (id: string, name: string) => ({
      id,
      name,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      model: "m",
      contextWindow: 1000,
      projectDir: "/test",
    });
    store.saveMeta("assist1", mk("assist1", "AssistantOnly"));
    store.appendMessage("assist1", { role: "assistant", content: "hello", timestamp: now });
    store.saveMeta("ws1", mk("ws1", "Whitespace"));
    store.appendMessage("ws1", { role: "user", content: "   ", timestamp: now });
    store.saveMeta("real1", mk("real1", "Real"));
    store.appendMessage("real1", { role: "user", content: "hi", timestamp: now });
    store.saveMeta("fresh1", mk("fresh1", "Fresh"));
    const deleted = manager.pruneEmpty("fresh1");
    expect(deleted).toContain("assist1");
    expect(deleted).toContain("ws1");
    expect(deleted).not.toContain("real1");
    expect(deleted).not.toContain("fresh1");
    expect(manager.get("real1")).not.toBeNull();
  });

  it("isEmptySession is fail-open for unknown ids and pruneEmpty never throws", () => {
    expect(manager.isEmptySession("ghost")).toBe(false);
    const fresh = manager.create("Fresh");
    expect(() => manager.pruneEmpty(fresh.id)).not.toThrow();
    expect(manager.get(fresh.id)).not.toBeNull();
  });
});
