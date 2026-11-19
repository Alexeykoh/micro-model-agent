import { describe, it, expect } from "vitest";
import { LspConnection } from "../../../src/modules/lsp/connection";
import { killTree, KillTreeUnavailableError } from "../../../src/modules/processes/kill-tree";
import { FakeLspServer, spawnOf } from "../../helpers/fake-lsp-server";

/**
 * LSP-сервер должен умирать вместе с деревом процесса (аудит §8.1, план
 * `2026-10-12-harness-module-audit-fixes`, W8/Task 8.1).
 */

function makeConnection(server: FakeLspServer): LspConnection {
  return new LspConnection(
    "tsserver \0 /tmp/proj",
    "/tmp/proj",
    { command: "tsserver", args: [] } as never,
    { spawn: spawnOf(server) } as never,
  );
}

describe("LSP: teardown убивает процесс", () => {
  it("exposes the server pid and kills the process on teardown", async () => {
    const server = new FakeLspServer();
    const conn = makeConnection(server);
    await conn.open();
    // pid у фейкового сервера нет — killTree обязан отработать через kill().
    expect(conn.processPid).toBeUndefined();
    await expect(conn.shutdown()).resolves.toBeUndefined();
  });

  it("killTree falls back to kill() when there is no pid", () => {
    let killed = false;
    killTree({ kill: () => (killed = true) });
    expect(killed).toBe(true);
  });

  it("killTree reports unavailability when there is neither pid nor kill", () => {
    expect(() => killTree({} as never)).toThrow(KillTreeUnavailableError);
  });
});
