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

  it("should list sessions in reverse chronological order", () => {
    manager.create("First");
    manager.create("Second");
    manager.create("Third");
    const list = manager.list();
    expect(list).toHaveLength(3);
    expect(list[0].name).toBe("Third");
  });

  it("should set and get active session", () => {
    const s1 = manager.create("S1");
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
    limitedManager.create("S2");
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
});
