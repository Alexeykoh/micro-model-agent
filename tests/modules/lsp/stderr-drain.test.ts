import { describe, it, expect } from "vitest";
import { LspConnection } from "../../../src/modules/lsp/connection";
import { FakeLspServer, spawnOf } from "../../helpers/fake-lsp-server";

/**
 * stderr сервера читается: «болтливый» сервер не должен вставать на
 * заполненном пайпе (аудит §8.2, план
 * `2026-10-12-harness-module-audit-fixes`, W8/Task 8.2).
 */

function makeConnection(server: FakeLspServer): LspConnection {
  return new LspConnection(
    "tsserver \0 /tmp/proj",
    "/tmp/proj",
    { command: "tsserver", args: [] } as never,
    { spawn: spawnOf(server) } as never,
  );
}

describe("LSP: stderr сервера", () => {
  it("a chatty server does not deadlock on stderr", async () => {
    const server = new FakeLspServer({
      requests: { "workspace/symbol": { symbols: [] } },
    });
    const conn = makeConnection(server);
    await conn.open();

    // «Болтовня» в stderr: 200 КБ — больше, чем пайп держит без чтения.
    for (let i = 0; i < 200; i++) {
      server.stderr.write("npm warn something happened ".repeat(40));
    }

    const result = await conn.request("workspace/symbol", {}, 5000);
    expect(result).toBeDefined();
    // stderr прочитан: в буфере ничего не осталось (иначе сервер встал бы).
    expect(server.stderr.readableLength).toBe(0);
  });

  it("keeps only the tail of stderr for diagnostics", async () => {
    const server = new FakeLspServer();
    const conn = makeConnection(server);
    await conn.open();

    server.stderr.write("A".repeat(10_000));

    expect(conn.stderrTail.length).toBeLessThanOrEqual(4096);
    expect(conn.stderrTail.length).toBeGreaterThan(0);
  });
});
