import { describe, expect, it } from "vitest";
import { FakeLspServer, spawnOf, parseWire } from "../../helpers/fake-lsp-server";
import { LspConnection } from "../../../src/modules/lsp/connection";
import type { LspServerConfig } from "../../../src/modules/lsp/types";

/**
 * `initializationOptions` уходят в `initialize`. Нужны там, где сервер сам
 * выбирает инструментарий: `tsserver.path` заставляет
 * `typescript-language-server` взять современный TypeScript вместо старого из
 * проекта (живой случай: Angular 11 + TypeScript 4.1.2 → сервер умирает на
 * `didOpen`, хотя `initialize` проходит).
 */

const ROOT = "/repo";

function connection(server: FakeLspServer, config: LspServerConfig): LspConnection {
  return new LspConnection("typescript", ROOT, config, {
    spawn: spawnOf(server),
    resolveLaunch: (cfg) => ({ command: cfg.command, args: cfg.args ?? [] }),
  });
}

describe("LSP initialize: initializationOptions", () => {
  it("передаёт серверные опции в initialize", async () => {
    const server = new FakeLspServer();
    const conn = connection(server, {
      command: "tls",
      initializationOptions: { tsserver: { path: "/opt/typescript/lib/tsserver.js" } },
    });
    await conn.open();

    const init = parseWire(server.written).find((m) => m.method === "initialize");
    expect((init?.params as { initializationOptions?: unknown }).initializationOptions).toEqual({
      tsserver: { path: "/opt/typescript/lib/tsserver.js" },
    });
    await conn.shutdown();
  });

  it("не добавляет поле, когда опций нет", async () => {
    const server = new FakeLspServer();
    const conn = connection(server, { command: "tls" });
    await conn.open();

    const init = parseWire(server.written).find((m) => m.method === "initialize");
    expect(init?.params).not.toHaveProperty("initializationOptions");
    await conn.shutdown();
  });
});
