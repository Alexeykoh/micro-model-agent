import { describe, expect, it } from "vitest";
import { FakeLspServer, parseWire, spawnOf } from "../../helpers/fake-lsp-server";
import { LspConnection } from "../../../src/modules/lsp/connection";
import type { LspServerConfig } from "../../../src/modules/lsp/types";

/**
 * Инварианты жизненного цикла LSP (спека 3.17/3.18 + практика
 * `vscode-languageclient`):
 *
 * - клиент передаёт `workDoneToken`, чтобы сервер мог сообщить «загружаю
 *   проект» через `$/progress` (иначе «жив, но занят» неотличим от таймаута);
 * - код выхода несёт смысл: 0 — чистый выход после `shutdown`, 1/сигнал —
 *   крах; без него `[LSP check failed]` не говорит, что случилось.
 */

const ROOT = "/repo";
const SERVER: LspServerConfig = { command: "tls" };

function connection(server: FakeLspServer): LspConnection {
  return new LspConnection("typescript", ROOT, SERVER, {
    spawn: spawnOf(server),
    resolveLaunch: (cfg) => ({ command: cfg.command, args: cfg.args ?? [] }),
  });
}

describe("LSP lifecycle invariants", () => {
  it("просит прогресс инициализации (workDoneToken) и показывает его", async () => {
    const server = new FakeLspServer();
    const conn = connection(server);
    await conn.open();

    const init = parseWire(server.written).find((m) => m.method === "initialize");
    expect(init).toBeDefined();
    const params = init?.params as { workDoneToken?: unknown } | undefined;
    expect(params?.workDoneToken).toBeTruthy();

    server.writeToClient({
      jsonrpc: "2.0",
      method: "$/progress",
      params: { token: "mma/lsp-init", value: { kind: "report", message: "Loading project" } },
    });
    expect(conn.lastProgress).toBe("Loading project");

    server.writeToClient({
      jsonrpc: "2.0",
      method: "$/progress",
      params: { token: "mma/lsp-init", value: { kind: "end" } },
    });
    expect(conn.lastProgress).toBeNull();
    await conn.shutdown();
  });

  it("несёт код выхода в причине падения (0 — чистый, 1 — крах)", async () => {
    const server = new FakeLspServer({ ignore: ["workspace/symbol"] });
    const conn = connection(server);
    await conn.open();

    const pending = conn.request("workspace/symbol", { query: "x" }, 5000);
    server.emit("exit", 1, null);

    await expect(pending).rejects.toThrow(/exited \(code 1\)/);
    expect(conn.lastExit).toEqual({ code: 1, signal: null });
  });

  it("сигнал завершения тоже виден", async () => {
    const server = new FakeLspServer({ ignore: ["workspace/symbol"] });
    const conn = connection(server);
    await conn.open();

    const pending = conn.request("workspace/symbol", { query: "x" }, 5000);
    server.emit("exit", null, "SIGKILL");

    await expect(pending).rejects.toThrow(/signal SIGKILL/);
    expect(conn.lastExit?.signal).toBe("SIGKILL");
  });
});
