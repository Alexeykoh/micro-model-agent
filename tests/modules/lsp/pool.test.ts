import { describe, expect, it } from "vitest";
import { FakeLspServer, spawnOf } from "../../helpers/fake-lsp-server";
import { LspConnectionPool } from "../../../src/modules/lsp/pool";
import type { LspServerConfig, LspConnectionDeps } from "../../../src/modules/lsp/connection";

const ROOT = "/repo";
const SERVER: LspServerConfig = { command: "fake", args: [] };

const deps = (server: FakeLspServer): LspConnectionDeps => ({
  spawn: spawnOf(server),
  resolveLaunch: (config) => ({ command: config.command, args: config.args ?? [] }),
});

/** Виртуальные часы: пул считает idle по `now()`. */
const clock = () => {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
};

describe("LspConnectionPool", () => {
  it("reuses one connection per server across calls", async () => {
    const server = new FakeLspServer();
    const pool = new LspConnectionPool(deps(server));
    const first = await pool.acquire("typescript", SERVER, ROOT);
    const second = await pool.acquire("typescript", SERVER, ROOT);
    expect(first).toBe(second);
    expect(first.isOpen).toBe(true);
    await pool.dispose();
  });

  it("opens a separate connection per project root", async () => {
    const server = new FakeLspServer();
    const pool = new LspConnectionPool(deps(server));
    const a = await pool.acquire("typescript", SERVER, "/repo/a");
    const b = await pool.acquire("typescript", SERVER, "/repo/b");
    expect(a).not.toBe(b);
    expect(pool.keys()).toHaveLength(2);
    await pool.dispose();
  });

  it("serves concurrent acquires for the same key from one spawn", async () => {
    const server = new FakeLspServer();
    const pool = new LspConnectionPool(deps(server));
    const [a, b] = await Promise.all([
      pool.acquire("typescript", SERVER, ROOT),
      pool.acquire("typescript", SERVER, ROOT),
    ]);
    expect(a).toBe(b);
    const inits = server.written.join("").match(/"method":"initialize"/g) ?? [];
    expect(inits).toHaveLength(1);
    await pool.dispose();
  });

  it("restarts a connection whose server died on its own", async () => {
    const server = new FakeLspServer();
    const pool = new LspConnectionPool(deps(server));
    const first = await pool.acquire("typescript", SERVER, ROOT);
    server.die();
    expect(first.isOpen).toBe(false);

    const second = await pool.acquire("typescript", SERVER, ROOT);
    expect(second).not.toBe(first);
    expect(second.isOpen).toBe(true);
    expect(pool.stats().restarts).toBe(1);
    await pool.dispose();
  });

  it("evicts the least recently used connection over the cap", async () => {
    const server = new FakeLspServer();
    const pool = new LspConnectionPool(deps(server), { maxServers: 2 });
    await pool.acquire("s1", SERVER, "/a");
    await pool.acquire("s2", SERVER, "/b");
    await pool.acquire("s3", SERVER, "/c");
    expect(pool.keys()).toHaveLength(2);
    // s1 простаивал дольше всех — вытеснен.
    expect(pool.peek("s1", "/a")).toBeNull();
    expect(pool.peek("s2", "/b")).not.toBeNull();
    expect(pool.peek("s3", "/c")).not.toBeNull();
    await pool.dispose();
  });

  it("keeps a hot connection and reaps an idle one", async () => {
    const server = new FakeLspServer();
    const c = clock();
    const pool = new LspConnectionPool(deps(server), { idleMs: 1000, now: c.now });
    const hot = await pool.acquire("typescript", SERVER, ROOT);
    await pool.acquire("python", { command: "fake2" }, ROOT);
    expect(pool.keys()).toHaveLength(2);

    c.advance(2000);
    // Грев горячего соединения сбрасывает его idle-таймер.
    hot.touch();
    await pool.reapIdle();
    expect(pool.peek("typescript", ROOT)).toBe(hot);
    expect(pool.peek("python", ROOT)).toBeNull();
    expect(pool.stats().reaped).toBe(1);
    await pool.dispose();
  });

  it("shuts everything down on dispose", async () => {
    const server = new FakeLspServer();
    const pool = new LspConnectionPool(deps(server));
    const conn = await pool.acquire("typescript", SERVER, ROOT);
    await pool.dispose();
    expect(conn.isOpen).toBe(false);
    expect(pool.keys()).toHaveLength(0);
    await expect(pool.acquire("typescript", SERVER, ROOT)).rejects.toThrow(/disposed/i);
  });
});
