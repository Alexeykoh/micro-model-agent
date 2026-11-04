/**
 * Кеш реестра сессий (INV-W3, спека 2026-11-04-webui-latency-design, C3):
 * список кешируется на TTL и сбрасывается записью/удалением меты; отрицательные
 * меты кешируются тоже — скан не статит тысячи несуществующих `meta.json`.
 *
 * До правки `listSessions()` на 3 874 каталога делал ~3 874 `existsSync`
 * синхронно в event loop (~150 мс на каждый `activate` сессии).
 *
 * TTL в тестах задаётся явно (`cacheTtlMs`), чтобы проверки не зависели от
 * реального времени: большое окно доказывает попадание в кеш, `0` — истечение.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/modules/session/store";
import type { SessionMeta } from "../../src/modules/session/types";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function meta(id: string): SessionMeta {
  const now = new Date().toISOString();
  return {
    id,
    name: id,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    model: "qwen/qwen3.5-9b",
    contextWindow: 32768,
    projectDir: "/some/project",
  };
}

function makeStore(cacheTtlMs: number): { dir: string; store: SessionStore } {
  const dir = mkdtempSync(join(tmpdir(), "mma-session-cache-"));
  dirs.push(dir);
  const store = new SessionStore(dir, undefined, { cacheTtlMs });
  store.init();
  return { dir, store };
}

/** Мета, записанная в обход стора — так ведёт себя второй процесс. */
function writeForeign(dir: string, id: string): void {
  mkdirSync(join(dir, id), { recursive: true });
  writeFileSync(join(dir, id, "meta.json"), JSON.stringify(meta(id)));
}

const LONG_TTL = 60_000;

describe("session list cache (INV-W3)", () => {
  it("serves the cached list inside the TTL window", () => {
    const { dir, store } = makeStore(LONG_TTL);
    store.saveMeta("a", meta("a"));
    expect(store.listSessions().map((s) => s.id)).toEqual(["a"]);

    writeForeign(dir, "b");
    expect(store.listSessions().map((s) => s.id)).toEqual(["a"]);
  });

  it("rescans when the TTL window has passed", () => {
    const { dir, store } = makeStore(0);
    store.saveMeta("a", meta("a"));
    expect(store.listSessions().map((s) => s.id)).toEqual(["a"]);

    writeForeign(dir, "b");
    expect(
      store
        .listSessions()
        .map((s) => s.id)
        .sort(),
    ).toEqual(["a", "b"]);
  });

  it("invalidates on saveMeta", () => {
    const { dir, store } = makeStore(LONG_TTL);
    store.saveMeta("a", meta("a"));
    expect(store.listSessions().map((s) => s.id)).toEqual(["a"]);

    writeForeign(dir, "b");
    expect(store.listSessions().map((s) => s.id)).toEqual(["a"]);

    // Запись через стор сбрасывает кеш — наружу выглядит и чужая сессия.
    store.saveMeta("c", meta("c"));
    expect(
      store
        .listSessions()
        .map((s) => s.id)
        .sort(),
    ).toEqual(["a", "b", "c"]);
  });

  it("invalidates on deleteSession", () => {
    const { store } = makeStore(LONG_TTL);
    store.saveMeta("a", meta("a"));
    store.saveMeta("b", meta("b"));
    expect(store.listSessions()).toHaveLength(2);

    store.deleteSession("a");
    expect(store.listSessions().map((s) => s.id)).toEqual(["b"]);
  });

  it("keeps the updatedAt-desc order across cached reads", () => {
    const { store } = makeStore(LONG_TTL);
    const older = meta("older");
    older.updatedAt = "2026-01-01T00:00:00.000Z";
    const newer = meta("newer");
    newer.updatedAt = "2026-06-01T00:00:00.000Z";
    store.saveMeta("older", older);
    store.saveMeta("newer", newer);
    expect(store.listSessions().map((s) => s.id)).toEqual(["newer", "older"]);
    expect(store.listSessions().map((s) => s.id)).toEqual(["newer", "older"]);
  });

  it("hides a foreign meta inside the TTL window and shows it after expiry", () => {
    const { dir, store } = makeStore(LONG_TTL);
    expect(store.loadMeta("x")).toBeNull();
    writeForeign(dir, "x");
    expect(store.loadMeta("x")).toBeNull();

    const fresh = new SessionStore(dir, undefined, { cacheTtlMs: 0 });
    expect(fresh.loadMeta("x")?.id).toBe("x");
  });

  it("clears the negative cache for an id written through the store", () => {
    const { store } = makeStore(LONG_TTL);
    expect(store.loadMeta("x")).toBeNull();
    store.saveMeta("x", meta("x"));
    expect(store.loadMeta("x")?.id).toBe("x");
  });
});
