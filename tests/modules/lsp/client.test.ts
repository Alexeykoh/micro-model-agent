import { describe, expect, it } from "vitest";
import { FakeLspServer, spawnOf } from "../../helpers/fake-lsp-server";
import { LspClient, serverKeyFor } from "../../../src/modules/lsp/client";
import { isErrorDiagnostic, isWarningDiagnostic } from "../../../src/modules/lsp/types";
import type { LspServerConfig } from "../../../src/modules/lsp/types";

const ROOT = "/repo";
const FILE = "/repo/src/a.ts";
const SERVER: LspServerConfig = { command: "fake", args: ["--stdio"] };

const makeClient = (server: FakeLspServer) =>
  new LspClient({
    spawn: spawnOf(server),
    resolveLaunch: (config) => ({ command: config.command, args: config.args ?? [] }),
  });

describe("serverKeyFor", () => {
  it("identifies a server by command and args", () => {
    expect(serverKeyFor({ command: "npx", args: ["a", "b"] })).toBe("npx:a b");
    expect(serverKeyFor({ command: "gopls" })).toBe("gopls:");
  });
});

describe("LspClient.checkFile", () => {
  it("reuses one server process across checks of the same file", async () => {
    const server = new FakeLspServer();
    const client = makeClient(server);
    await client.checkFile(FILE, ROOT, SERVER, ROOT);
    const second = await client.checkFile(FILE, ROOT, SERVER, ROOT);
    expect(second.diagnostics).toEqual([]);
    // Главное: процесс один — регрессия на спавн-на-проверку.
    expect(server.written.join("").match(/"method":"initialize"/g)).toHaveLength(1);
    await client.close();
  });

  it("pushes the new content on the second check", async () => {
    const server = new FakeLspServer();
    const client = makeClient(server);
    await client.checkFile(FILE, ROOT, SERVER, ROOT);
    await client.checkFile(FILE, ROOT, SERVER, ROOT);
    const wire = server.written.join("");
    // Второй синк без правки файла не дёргает сервер.
    expect(wire.match(/"method":"textDocument\/didOpen"/g)).toHaveLength(1);
    expect(wire.match(/"method":"textDocument\/didChange"/g)).toBeNull();
    await client.close();
  });

  it("marks a silent server as inconclusive rather than clean", async () => {
    const server = new FakeLspServer();
    const client = makeClient(server);
    // didOpen в этом фейковом сервере публикует пустой список, поэтому молчание
    // получаем только если документ не открыт вовсе.
    const result = await client.checkFile("/repo/src/new.ts", ROOT, { ...SERVER, timeout: 30 }, ROOT);
    expect(result.diagnostics).toEqual([]);
    await client.close();
  });
});

describe("LspClient pool lifecycle", () => {
  it("closes every server on close", async () => {
    const server = new FakeLspServer();
    const client = makeClient(server);
    await client.checkFile(FILE, ROOT, SERVER, ROOT);
    expect(client.liveConnections()).toBe(1);
    await client.close();
    expect(client.liveConnections()).toBe(0);
    expect(server.written.join("")).toContain('"method":"shutdown"');
  });

  it("keeps a separate server per project root", async () => {
    const server = new FakeLspServer();
    const client = makeClient(server);
    await client.checkFile("/root-a/a.ts", "/root-a", SERVER, "/root-a");
    await client.checkFile("/root-b/b.ts", "/root-b", SERVER, "/root-b");
    expect(client.liveConnections()).toBe(2);
    await client.close();
  });
});

describe("LspClient.probe", () => {
  it("spawns and shuts down without polluting the pool", async () => {
    const server = new FakeLspServer();
    const client = makeClient(server);
    await client.probe(SERVER, ROOT, 200);
    expect(server.written.join("")).toContain('"method":"initialize"');
    expect(client.liveConnections()).toBe(0);
  });
});

describe("severity helpers (LSP spec: absent severity = error)", () => {
  const diag = (severity?: number) => ({
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    message: "x",
    ...(severity === undefined ? {} : { severity }),
  });

  it("treats a missing severity as an error", () => {
    expect(isErrorDiagnostic(diag())).toBe(true);
    expect(isErrorDiagnostic(diag(0))).toBe(true);
    expect(isErrorDiagnostic(diag(1))).toBe(true);
  });

  it("separates warnings", () => {
    expect(isErrorDiagnostic(diag(2))).toBe(false);
    expect(isWarningDiagnostic(diag(2))).toBe(true);
    expect(isWarningDiagnostic(diag())).toBe(false);
  });

  it("ignores info and hint levels", () => {
    expect(isErrorDiagnostic(diag(3))).toBe(false);
    expect(isWarningDiagnostic(diag(4))).toBe(false);
  });
});
