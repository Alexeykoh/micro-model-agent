import { describe, expect, it } from "vitest";
import { FakeLspServer, spawnOf, frame, parseWire } from "../../helpers/fake-lsp-server";
import { LspConnection } from "../../../src/modules/lsp/connection";
import { buildClientCapabilities } from "../../../src/modules/lsp/connection";

const ROOT = "/repo";
const FILE = "/repo/src/a.ts";
const URI = "file:///repo/src/a.ts";

const makeConnection = (server: FakeLspServer) =>
  new LspConnection("typescript", ROOT, { command: "fake", args: [] }, {
    spawn: spawnOf(server),
    resolveLaunch: (config) => ({ command: config.command, args: config.args ?? [] }),
  });

describe("LspConnection handshake", () => {
  it("sends initialize with negotiated capabilities and clientInfo", async () => {
    const server = new FakeLspServer();
    const conn = makeConnection(server);
    await conn.open();

    const init = parseWire(server.written)[0];
    expect(init.method).toBe("initialize");
    expect(init.params.rootUri).toBe("file:///repo");
    expect(init.params.clientInfo.name).toBe("micro-models-agent");
    const caps = buildClientCapabilities();
    expect(init.params.capabilities.general.positionEncodings).toEqual(["utf-16"]);
    expect(init.params.capabilities.textDocument.diagnostic).toEqual({});
    expect(init.params.capabilities).toMatchObject({ textDocument: { diagnostic: {} } });
    expect(caps.textDocument.publishDiagnostics.versionSupport).toBe(true);
  });

  it("sends initialized after the initialize response", async () => {
    const server = new FakeLspServer();
    const conn = makeConnection(server);
    await conn.open();
    const wire = server.written.join("");
    expect(wire).toContain('"method":"initialized"');
  });

  it("reports isOpen only after a successful handshake", async () => {
    const server = new FakeLspServer();
    const conn = makeConnection(server);
    expect(conn.isOpen).toBe(false);
    await conn.open();
    expect(conn.isOpen).toBe(true);
    await conn.shutdown();
    expect(conn.isOpen).toBe(false);
  });
});

describe("LspConnection document sync", () => {
  it("не принимает ранний пустой пуш за «ошибок нет»", async () => {
    // tsserver: сначала v1 n=0, через ~140 мс — v1 с ошибками. Панель не должна
    // показать «чисто» на первом пуше (живой Catalog.tsx, 2026-10-29).
    const server = new FakeLspServer();
    const conn = makeConnection(server);
    await conn.open();
    const uri = conn.syncDocument(FILE, "const a: number = 'x';");
    setTimeout(() => {
      server.writeToClient({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: {
          uri,
          diagnostics: [
            { range: { start: { line: 0, character: 0 } }, severity: 1, message: "Type" },
          ],
          version: 1,
        },
      });
    }, 120);

    const diags = await conn.diagnosticsFor(uri, 2000);

    expect(diags?.map((d) => d.message)).toEqual(["Type"]);
  });

  it("принимает диагностику в записи сервера (`c%3A` vs `C:`)", async () => {
    const server = new FakeLspServer();
    const conn = makeConnection(server);
    await conn.open();

    conn.syncUri("file:///C:/repo/src/a.ts", "typescript", "const a = 1;");
    server.writeToClient({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: "file:///c%3A/repo/src/a.ts",
        diagnostics: [
          { range: { start: { line: 0, character: 0 } }, severity: 1, message: "boom" },
        ],
        version: 1,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const rec = conn.peekDiagnostics("file:///C:/repo/src/a.ts");
    expect(rec?.diagnostics.map((d) => d.message)).toEqual(["boom"]);
  });
  it("opens a document once and pushes full text on change", async () => {
    const server = new FakeLspServer();
    const conn = makeConnection(server);
    await conn.open();

    const uri = conn.syncDocument(FILE, "const a = 1;");
    conn.syncUri(uri, "typescript", "const a = 2;");
    conn.syncUri(uri, "typescript", "const a = 2;");

    const wire = server.written.join("");
    const opens = wire.split('"method":"textDocument/didOpen"').length - 1;
    const changes = wire.split('"method":"textDocument/didChange"').length - 1;
    expect(opens).toBe(1);
    expect(changes).toBe(1); // второй sync без правок — no-op
    expect(wire).toContain('"version":2');
    expect(wire).toContain("const a = 2;");
  });

  it("closes a document with didClose and forgets its diagnostics", async () => {
    const server = new FakeLspServer();
    const conn = makeConnection(server);
    await conn.open();
    const uri = conn.syncDocument(FILE, "let x");
    conn.closeDocument(FILE);
    expect(conn.openDocumentUris()).not.toContain(uri);
    expect(server.written.join("")).toContain('"method":"textDocument/didClose"');
  });
});

describe("LspConnection diagnostics", () => {
  it("replaces the previous push for the same uri", async () => {
    const server = new FakeLspServer();
    const conn = makeConnection(server);
    await conn.open();
    conn.syncDocument(FILE, "let x");

    const push = (diagnostics: unknown[]) =>
      server.writeToClient({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: { uri: URI, diagnostics, version: 1 },
      });

    push([{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: "first", severity: 1 }]);
    await conn.diagnosticsFor(URI, 200);
    push([]);
    await conn.diagnosticsFor(URI, 200);
    expect(conn.peekDiagnostics(URI)?.diagnostics).toEqual([]);
  });

  it("ignores a stale push for an older document version", async () => {
    const server = new FakeLspServer();
    const conn = makeConnection(server);
    await conn.open();
    conn.syncDocument(FILE, "v1");
    conn.syncUri(URI, "typescript", "v2");
    server.writeToClient({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri: URI, diagnostics: [{ message: "stale error", severity: 1 }], version: 1 },
    });
    const result = await conn.diagnosticsFor(URI, 120);
    expect(result).toBeNull(); // сервер не ответил на версию 2
  });

  it("returns null (not an empty list) when the server stays silent", async () => {
    const server = new FakeLspServer();
    const conn = makeConnection(server);
    await conn.open();
    const fresh = new FakeLspServer();
    const conn2 = makeConnection(fresh);
    await conn2.open();
    const uriB = conn2.syncDocument("/repo/src/b.ts", "let y");
    fresh.die();
    expect(await conn2.diagnosticsFor(uriB, 80)).toBeNull();
    expect(conn2.peekDiagnostics(uriB)).toBeNull();
  });

  it("uses the pull model when the server advertises diagnosticProvider", async () => {
    const server = new FakeLspServer({
      requests: {
        initialize: { capabilities: { diagnosticProvider: { identifier: "fake", interFileDependencies: false } } },
        "textDocument/diagnostic": {
          kind: "full",
          items: [{ range: { start: { line: 3, character: 0 }, end: { line: 3, character: 4 } }, message: "pulled", severity: 1 }],
        },
      },
    });
    const conn = makeConnection(server);
    await conn.open();
    conn.syncDocument(FILE, "let x");
    const diags = await conn.diagnosticsFor(URI, 300);
    expect(diags?.map((d) => d.message)).toEqual(["pulled"]);
    expect(server.written.join("")).toContain('"method":"textDocument/diagnostic"');
  });

  it("falls back to push when the server has no diagnosticProvider", async () => {
    const server = new FakeLspServer({
      requests: {
        initialize: { capabilities: {} },
        "textDocument/diagnostic": { kind: "full", items: [{ message: "should not be used", severity: 1 }] },
      },
    });
    const conn = makeConnection(server);
    await conn.open();
    conn.syncDocument(FILE, "let x");
    const diags = await conn.diagnosticsFor(URI, 300);
    expect(diags).toEqual([]); // ответ didOpen-пушем, pull не запрашивался
    expect(server.written.join("")).not.toContain('"method":"textDocument/diagnostic"');
  });
});

describe("LspConnection requests", () => {
  it("correlates a response by id", async () => {
    const server = new FakeLspServer({ requests: { "workspace/symbol": [{ name: "A" }] } });
    const conn = makeConnection(server);
    await conn.open();
    const result = await conn.request("workspace/symbol", { query: "A" }, 500);
    expect(result).toEqual([{ name: "A" }]);
  });

  it("rejects on a JSON-RPC error result", async () => {
    const server = new FakeLspServer({ errors: { "textDocument/hover": "no hover here" } });
    const conn = makeConnection(server);
    await conn.open();
    await expect(conn.request("textDocument/hover", { x: 1 }, 500)).rejects.toThrow("no hover here");
  });

  it("resolves null for a request the server answers empty", async () => {
    const server = new FakeLspServer();
    const conn = makeConnection(server);
    await conn.open();
    // Хендлера нет — сервер отвечает result:null, это валидный LSP-ответ.
    await expect(conn.request("textDocument/hover", { x: 1 }, 500)).resolves.toBeNull();
  });

  it("times out without hanging the connection", async () => {
    const server = new FakeLspServer({ ignore: ["workspace/symbol"] });
    const conn = makeConnection(server);
    await conn.open();
    await expect(conn.request("workspace/symbol", { query: "q" }, 60)).rejects.toThrow(/timeout/i);
    expect(conn.isOpen).toBe(true);
  });

  it("answers a server->client request instead of leaving it dangling", async () => {
    const server = new FakeLspServer();
    const conn = makeConnection(server);
    await conn.open();
    server.emit("data", Buffer.from(frame({ jsonrpc: "2.0", id: 501, method: "workspace/configuration", params: { items: [] } })));
    await new Promise((r) => setTimeout(r, 30));
    expect(server.written.join("")).toContain('"id":501');
  });

  it("accepts LF-separated frames", async () => {
    const server = new FakeLspServer();
    const conn = makeConnection(server);
    await conn.open();
    server.emit("data", Buffer.from(frame({ jsonrpc: "2.0", id: 7, method: "workspace/configuration", params: {} }, "\n")));
    await new Promise((r) => setTimeout(r, 30));
    expect(server.written.join("")).toContain('"id":7');
  });
});

describe("LspConnection shutdown", () => {
  it("sends shutdown then exit and kills the tree", async () => {
    const server = new FakeLspServer();
    const conn = makeConnection(server);
    await conn.open();
    await conn.shutdown();
    const wire = server.written.join("");
    expect(wire).toContain('"method":"shutdown"');
    expect(wire).toContain('"method":"exit"');
    expect(wire.indexOf('"method":"shutdown"')).toBeLessThan(wire.indexOf('"method":"exit"'));
  });

  it("drops the connection when the server dies on its own", async () => {
    const server = new FakeLspServer();
    const conn = makeConnection(server);
    await conn.open();
    expect(conn.isOpen).toBe(true);
    server.die();
    expect(conn.isOpen).toBe(false);
    await expect(conn.request("workspace/symbol", {}, 50)).rejects.toThrow(/no process/i);
  });

  it("rejects in-flight requests when the server dies", async () => {
    const server = new FakeLspServer({ ignore: ["workspace/symbol"] });
    const conn = makeConnection(server);
    await conn.open();
    const pending = conn.request("workspace/symbol", {}, 1000);
    server.die();
    await expect(pending).rejects.toThrow(/exited/i);
  });
});
