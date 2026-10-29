import { describe, expect, it } from "vitest";
import { DEFAULT_LSP_CONFIG } from "../../../src/modules/lsp/config";
import { extractBinaryFromNpxArgs, resolveNpxLaunch } from "../../../src/modules/lsp/resolve";

/**
 * Дефолты серверов должны запускать LSP-энтрипоинт, а не CLI пакета.
 *
 * Живой дефект: python-сервер был `npx pyright --stdio` — это CLI pyright,
 * который печатает справку и выходит, поэтому `.py` никогда не проверялись
 * («LSP server exited» на каждой попытке). LSP-энтрипоинт пакета —
 * `pyright-langserver`.
 */
describe("DEFAULT_LSP_CONFIG: команды серверов", () => {
  it("python запускает pyright-langserver", () => {
    const python = DEFAULT_LSP_CONFIG.servers.python;
    expect(python.args).toContain("pyright-langserver");
    expect(extractBinaryFromNpxArgs(python.args ?? [])).toBe("pyright-langserver");
  });

  it("npx-серверы с бинарником резолвятся в него, когда он есть в PATH", () => {
    for (const key of ["typescript", "javascript", "json", "html", "css", "python"]) {
      const server = DEFAULT_LSP_CONFIG.servers[key];
      const binary = extractBinaryFromNpxArgs(server.args ?? []);
      expect(binary, `${key} должен иметь распознаваемый бинарник`).toBeTruthy();
      if (!binary) continue;
      const launch = resolveNpxLaunch(server.command, server.args ?? [], () => `/usr/bin/${binary}`);
      expect(launch.command).toBe(binary);
      expect(launch.useNpxFallback).toBe(false);
    }
  });

  it("пул держит по соединению на язык, а не только три", async () => {
    const { LSP_MAX_SERVERS } = await import("../../../src/config/timeouts");
    expect(LSP_MAX_SERVERS).toBeGreaterThanOrEqual(5);
  });
});
