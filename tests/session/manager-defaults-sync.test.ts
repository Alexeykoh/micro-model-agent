// Guard: новая сессия пишет модель и окно, которые действуют СЕЙЧАС.
//
// Регресс из стресс-теста (волна 17): сессии, работавшие на e4b, хранили в
// meta.json `"model": "deepseek-v4.1-flash"` (при верном contextWindow).
// `SessionManager.create()` берёт дефолты из `options` — снимка на bootstrap, а
// `setEffectiveContext()` после смены модели обновлял только мету активной
// сессии. Тот же корень давал чужую модель в шапке `/export` и в `/v1/sessions`.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/modules/session/store";
import { SessionManager } from "../../src/modules/session/manager";

describe("SessionManager: дефолты новых сессий следуют за reconfigure", () => {
  let dir: string;
  let manager: SessionManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mma-defaults-"));
    const store = new SessionStore(dir);
    store.init();
    manager = new SessionManager(store, {
      model: "old/model",
      contextWindow: 32768,
      projectDir: "/test",
    });
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("create() после смены модели записывает новую модель и окно", () => {
    manager.create("first");
    manager.setEffectiveContext(131072, "new/model");

    const meta = manager.create("second");

    expect(meta.model).toBe("new/model");
    expect(meta.contextWindow).toBe(131072);
  });

  it("синхронизация работает и без активной сессии", () => {
    manager.setEffectiveContext(65536, "cold/model");

    const meta = manager.create("cold");

    expect(meta.model).toBe("cold/model");
    expect(meta.contextWindow).toBe(65536);
  });

  it("без модели окно всё равно обновляется", () => {
    const meta = manager.create("window-only");
    manager.setEffectiveContext(4096);

    const next = manager.create("next");

    expect(next.model).toBe("old/model");
    expect(next.contextWindow).toBe(4096);
    expect(meta.model).toBe("old/model");
  });
});
