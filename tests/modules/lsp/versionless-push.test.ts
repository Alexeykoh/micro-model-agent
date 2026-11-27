import { describe, expect, it } from "vitest";
import { FakeLspServer, spawnOf } from "../../helpers/fake-lsp-server";
import { LspConnection } from "../../../src/modules/lsp/connection";
import type { LspClientLogger } from "../../../src/modules/lsp/client-logger";

const ROOT = "/repo";
const FILE = "/repo/src/a.ts";
const URI = "file:///repo/src/a.ts";

interface Warn {
  msg: string;
  meta?: Record<string, unknown>;
}

const makeLogger = (warns: Warn[]): LspClientLogger => ({
  debug: () => {},
  info: () => {},
  warn: (msg, meta) => warns.push({ msg, meta }),
  error: () => {},
});

const makeConnection = (server: FakeLspServer, logger: LspClientLogger | null = null) =>
  new LspConnection("typescript", ROOT, { command: "fake", args: [] }, {
    spawn: spawnOf(server),
    resolveLaunch: (config) => ({ command: config.command, args: config.args ?? [] }),
    logger,
  });

const diag = (message: string) => ({
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  severity: 1,
  message,
});

/** Пуш без `version` — ровно то, что присылает typescript-language-server. */
const push = (server: FakeLspServer, uri: string, messages: string[], version?: number) =>
  server.writeToClient({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: version === undefined ? { uri, diagnostics: messages.map(diag) } : { uri, diagnostics: messages.map(diag), version },
  });

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("LSP versionless publishDiagnostics", () => {
  it("не отдаёт диагностики старого текста, если после didChange пришёл свежий versionless пуш", async () => {
    const server = new FakeLspServer();
    const conn = makeConnection(server);
    await conn.open();
    const uri = conn.syncDocument(FILE, "const a = 1;");
    conn.syncUri(uri, "typescript", "const a = 2;");

    // Поздний пуш, посчитанный до правки, приходит после didChange без version.
    push(server, uri, ["stale"]);
    const pending = conn.diagnosticsFor(uri, 500);
    await wait(40);
    push(server, uri, ["fresh"]);

    expect((await pending)?.map((d) => d.message)).toEqual(["fresh"]);
  });

  it("пишет в лог счётчик «после didChange» и «заменён»", async () => {
    const warns: Warn[] = [];
    const server = new FakeLspServer();
    const conn = makeConnection(server, makeLogger(warns));
    await conn.open();
    const uri = conn.syncDocument(FILE, "const a = 1;");
    conn.syncUri(uri, "typescript", "const a = 2;");

    push(server, uri, ["stale"]);
    push(server, uri, ["fresh"]);
    await conn.diagnosticsFor(uri, 500);

    const messages = warns.map((w) => w.msg);
    expect(messages.some((m) => m.includes("versionless push after didChange"))).toBe(true);
    expect(messages.some((m) => m.includes("versionless push replaced"))).toBe(true);
    const counted = warns.find((w) => w.msg.includes("versionless push replaced"));
    expect(counted?.meta?.afterChange).toBeGreaterThanOrEqual(1);
    expect(counted?.meta?.replaced).toBeGreaterThanOrEqual(1);
    expect(conn.versionlessCounters).toEqual({ afterChange: 1, replaced: 1 });
  });

  it("оставляет предварительные диагностики в силе, если замены не пришло", async () => {
    const server = new FakeLspServer();
    const conn = makeConnection(server);
    await conn.open();
    const uri = conn.syncDocument(FILE, "const a = 1;");
    conn.syncUri(uri, "typescript", "const a = 2;");
    push(server, uri, ["only"]);

    expect((await conn.diagnosticsFor(uri, 500))?.map((d) => d.message)).toEqual(["only"]);
    expect(conn.versionlessCounters).toEqual({ afterChange: 1, replaced: 0 });
  });

  it("не считает гонкой пуш с version от текущей версии документа", async () => {
    const warns: Warn[] = [];
    const server = new FakeLspServer();
    const conn = makeConnection(server, makeLogger(warns));
    await conn.open();
    const uri = conn.syncDocument(FILE, "const a = 1;");
    push(server, uri, ["versioned"], 1);

    expect((await conn.diagnosticsFor(uri, 500))?.map((d) => d.message)).toEqual(["versioned"]);
    expect(warns).toEqual([]);
    expect(conn.versionlessCounters).toEqual({ afterChange: 0, replaced: 0 });
  });
});
