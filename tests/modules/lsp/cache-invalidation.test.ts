import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LspClient } from "../../../src/modules/lsp/client";
import { canonicalUri, pathToUri } from "../../../src/modules/lsp/uri";
import type { LspServerConfig } from "../../../src/modules/lsp/types";
import { FakeLspServer, parseWire, spawnOf } from "../../helpers/fake-lsp-server";

/**
 * Кэш диагностик LSP: сервер считает открытый буфер истиной и не видит правок
 * файла на диске, сделанных мимо write-хуков (`bash`, форматтер, git). Проверка
 * обязана пересинкать изменившиеся документы и не отдавать запись, посчитанную
 * до правки другого файла.
 */

const SERVER: LspServerConfig = { command: "fake", args: ["--stdio"], timeout: 5000 };

function makeClient(server: FakeLspServer): LspClient {
  return new LspClient({
    spawn: spawnOf(server),
    resolveLaunch: (config) => ({ command: config.command, args: config.args ?? [] }),
  });
}

function didChangeUris(server: FakeLspServer): string[] {
  return parseWire(server.written)
    .filter((message) => message.method === "textDocument/didChange")
    .map((message) => {
      const params = message.params as { textDocument?: { uri?: string } } | undefined;
      return params?.textDocument?.uri ?? "";
    });
}

function pushDiagnostics(server: FakeLspServer, uri: string, message: string): void {
  server.writeToClient({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: {
      uri,
      diagnostics: [{ range: { start: { line: 0, character: 0 } }, severity: 1, message }],
      version: 1,
    },
  });
}

function setup(): { dir: string; a: string; b: string } {
  const dir = mkdtempSync(join(tmpdir(), "mma-lsp-cache-"));
  const a = join(dir, "a.ts");
  const b = join(dir, "b.ts");
  writeFileSync(a, 'import { greet } from "./b";\nexport const x = greet();\n');
  writeFileSync(b, 'export const greet = () => "hi";\n');
  return { dir, a, b };
}

describe("LSP diagnostics cache invalidation", () => {
  it("re-syncs an open document changed on disk before a check", async () => {
    const { dir, a, b } = setup();
    const server = new FakeLspServer();
    const client = makeClient(server);
    try {
      await client.checkFile(b, dir, SERVER, dir, 200);
      writeFileSync(b, 'export const farewell = () => "bye";\n');

      await client.checkFile(a, dir, SERVER, dir, 200);

      expect(server.written.join("")).toContain("farewell");
      expect(didChangeUris(server)).toContain(canonicalUri(pathToUri(b)));
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a re-published verdict after another document changed", async () => {
    const { dir, a, b } = setup();
    const server = new FakeLspServer();
    const client = makeClient(server);
    try {
      expect((await client.checkFile(a, dir, SERVER, dir, 500)).diagnostics).toEqual([]);
      await client.checkFile(b, dir, SERVER, dir, 500);

      writeFileSync(b, 'export const farewell = () => "bye";\n');
      // Затронутый файл сервер публикует заново (у tsserver ~450 мс).
      setTimeout(() => pushDiagnostics(server, canonicalUri(pathToUri(a)), "b lost greet"), 50);
      const result = await client.checkFile(a, dir, SERVER, dir, 800);

      expect(result.inconclusive).toBe(false);
      expect(result.diagnostics.map((d) => d.message)).toEqual(["b lost greet"]);
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the last verdict when an unaffected file was not re-published", async () => {
    const { dir, a, b } = setup();
    const server = new FakeLspServer();
    const client = makeClient(server);
    try {
      await client.checkFile(a, dir, SERVER, dir, 500);
      await client.checkFile(b, dir, SERVER, dir, 500);

      writeFileSync(b, 'export const farewell = () => "bye";\n');
      const result = await client.checkFile(a, dir, SERVER, dir, 200);

      // Сервер не переопубликовал `a` → файл не затронут, прежний вердикт верен.
      expect(result.inconclusive).toBe(false);
      expect(result.diagnostics).toEqual([]);
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
