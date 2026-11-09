import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SessionStore } from "../../src/modules/session/store";
import { SessionManager } from "../../src/modules/session/manager";
import { newThreadId } from "../../src/modules/session/id";

function makeManager() {
  const dir = mkdtempSync(join(tmpdir(), "mma-threadid-"));
  const store = new SessionStore(dir);
  return {
    store,
    manager: new SessionManager(store, { model: "m", contextWindow: 32768, projectDir: dir }),
  };
}

describe("thread_id (durable state)", () => {
  it("generates thr_ id, < 255 chars, no raw text", () => {
    const id = newThreadId();
    expect(id).toMatch(/^thr_[0-9a-f]{16}$/);
    expect(id.length).toBeLessThan(255);
  });

  it("create() assigns threadId and round-trips through meta", () => {
    const { store, manager } = makeManager();
    const meta = manager.create();
    expect(meta.threadId).toMatch(/^thr_[0-9a-f]{16}$/);
    const reloaded = store.loadMeta(meta.id);
    expect(reloaded?.threadId).toBe(meta.threadId);
    expect(store.loadMeta(meta.id)?.name).toBe(meta.name);
  });

  it("old meta without threadId loads (undefined)", () => {
    const { store, manager } = makeManager();
    const meta = manager.create();
    // Пишем старую мету без threadId поверх — загрузчик обязан принять.
    const dir = store.getSessionDir(meta.id);
    mkdirSync(dir, { recursive: true });
    const { threadId: _drop, ...rest } = meta;
    writeFileSync(join(dir, "meta.json"), JSON.stringify(rest, null, 2), "utf-8");
    // store кеш очищать нельзя — идём напрямую через файла
    const fresh = new SessionStore(store.baseDirPath());
    expect(fresh.loadMeta(meta.id)?.threadId).toBeUndefined();
    expect(fresh.loadMeta(meta.id)?.id).toBe(meta.id);
  });
});
