import { describe, it, expect } from "vitest";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SessionStore } from "../../src/modules/session/store";
import { SessionManager } from "../../src/modules/session/manager";

describe("session retention prune", () => {
  it("deletes sessions older than retention, keeps active and fresh", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-retention-"));
    const store = new SessionStore(dir);
    const manager = new SessionManager(store, { model: "m", contextWindow: 32768, projectDir: dir });

    const old = manager.create("old one");
    store.saveMeta(old.id, { ...old, updatedAt: new Date(Date.now() - 40 * 86400000).toISOString() });
    const fresh = manager.create("fresh one");
    store.saveMeta(fresh.id, { ...fresh, updatedAt: new Date(Date.now() - 86400000).toISOString() });

    const deleted = manager.pruneByRetention(30);
    expect(deleted).toContain(old.id);
    expect(deleted).not.toContain(fresh.id);
    expect(store.loadMeta(old.id)).toBeNull();
    expect(store.loadMeta(fresh.id)).not.toBeNull();
  });

  it("never deletes the active session", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-retention-"));
    const store = new SessionStore(dir);
    const manager = new SessionManager(store, { model: "m", contextWindow: 32768, projectDir: dir });
    const active = manager.create("active");
    store.saveMeta(active.id, { ...active, updatedAt: new Date(Date.now() - 90 * 86400000).toISOString() });

    expect(manager.pruneByRetention(30)).toEqual([]);
    expect(store.loadMeta(active.id)).not.toBeNull();
  });
});
