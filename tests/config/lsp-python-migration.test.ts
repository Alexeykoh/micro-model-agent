import { describe, expect, it } from "vitest";
import { normalizeLspServerArgs } from "../../src/config/migrate-legacy";
import { DEFAULT_LSP_CONFIG } from "../../src/modules/lsp/config";
import type { AppConfig } from "../../src/config/types";

/**
 * Персист хранит `lsp.servers` целиком, поэтому смена дефолта сама до
 * пользователя не доезжает. Python-сервер был записан как `npx pyright --stdio`
 * (CLI пакета, не LSP): процесс печатал справку и выходил, `.py` не проверялись
 * никогда. Миграция обязана заменить именно это значение и не трогать правки
 * пользователя.
 */

function configWith(pythonArgs: string[]): AppConfig {
  return {
    lsp: {
      enabled: true,
      timeout: 15000,
      servers: {
        python: { command: "npx", args: pythonArgs, timeout: 15000 },
      },
    },
  } as unknown as AppConfig;
}

describe("normalizeLspServerArgs: python", () => {
  it("replaces the broken CLI invocation with the LSP entrypoint", () => {
    const cfg = configWith(["pyright", "--stdio"]);
    normalizeLspServerArgs(cfg);
    expect(cfg.lsp?.servers.python.args).toEqual(DEFAULT_LSP_CONFIG.servers.python.args);
    expect(cfg.lsp?.servers.python.args).toContain("pyright-langserver");
  });

  it("keeps a user-edited command alone", () => {
    const cfg = configWith(["--yes", "--package", "pyright", "pyright-langserver", "--stdio", "--verbose"]);
    const before = [...(cfg.lsp?.servers.python.args ?? [])];
    normalizeLspServerArgs(cfg);
    expect(cfg.lsp?.servers.python.args).toEqual(before);
  });

  it("does not touch a non-npx python command", () => {
    const cfg = {
      lsp: {
        enabled: true,
        timeout: 15000,
        servers: { python: { command: "/usr/bin/pyright-langserver", args: [] } },
      },
    } as unknown as AppConfig;
    normalizeLspServerArgs(cfg);
    expect(cfg.lsp?.servers.python.command).toBe("/usr/bin/pyright-langserver");
  });
});
