import { describe, it, expect } from "vitest";
import { LspConnection } from "../../../src/modules/lsp/connection";
import { FakeLspServer, spawnOf } from "../../helpers/fake-lsp-server";

/**
 * Диагностики хранят версию, ЗА КОТОРУЮ посчитал сервер, а выход СТАРОГО
 * процесса не роняет новое соединение (аудит §8.3/§8.4, план
 * `2026-10-12-harness-module-audit-fixes`, W8/Task 8.3).
 */

function makeConnection(
  server: FakeLspServer,
  spawn?: () => Promise<never>,
): LspConnection {
  return new LspConnection(
    "tsserver \0 /tmp/proj",
    "/tmp/proj",
    { command: "tsserver", args: [] } as never,
    { spawn: spawn ?? (spawnOf(server) as never) } as never,
  );
}

describe("LSP: версии диагностик и выход процесса", () => {
  it("keeps the version the server reported", async () => {
    const server = new FakeLspServer();
    const conn = makeConnection(server);
    await conn.open();

    const uri = "file:///tmp/proj/a.ts";
    conn.syncUri(uri, "typescript", "const a = 1;\n");

    // Сервер считает для другой версии — сохраняем ЕГО версию, а не текущую
    // документа (иначе устаревшие диагностики помечаются как свежие).
    server.writeToClient({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri, diagnostics: [], version: 3 },
    });

    expect(conn.peekDiagnostics(uri)?.version).toBe(3);
  });

  it("a stale process exit does not tear down the new connection", async () => {
    const first = new FakeLspServer();
    const second = new FakeLspServer();
    let calls = 0;
    const conn = makeConnection(first, (async () => {
      calls++;
      return (calls === 1 ? spawnOf(first) : spawnOf(second))();
    }) as never);

    await conn.open();
    // Первый процесс умер — соединение переподнимается на втором.
    first.die();
    await conn.open();
    expect(conn.isOpen).toBe(true);

    // Поздний exit ПЕРВОГО процесса не должен убить второе соединение.
    first.die();
    expect(conn.isOpen).toBe(true);
  });
});
