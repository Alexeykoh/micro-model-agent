import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LspModule } from "../../../src/modules/lsp/module";
import type { LspClient } from "../../../src/modules/lsp/client";
import type { ToolContext } from "../../../src/tools/types";
import type { LspConfig } from "../../../src/modules/lsp/types";

/**
 * Холодный старт LSP-сервера не должен блокировать запись: npx-докачка
 * language server занимала 30 с на первую запись (наблюдалось вживую:
 * write 31.5 с). Проверка идёт на тёплом соединении, прогрев — в фоне.
 * Аудит §8.2.
 */

const CONFIG: Partial<LspConfig> = {
  enabled: true,
  servers: {
    typescript: { command: "tsgo", args: ["--lsp"], workspaceMarkers: [] },
  },
};

function ctxFor(baseDir: string): ToolContext {
  return { baseDir, config: {} as never, logger: { warn: () => {} } } as unknown as ToolContext;
}

function writeCall(path: string) {
  return { name: "write_file", arguments: { path } } as never;
}

describe("LSP: пост-проверка записи", () => {
  it("does not block the write on a cold server and warms it in the background", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-lsp-cold-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");

      let warmCalls = 0;
      const client = {
        setOffline: () => {},
        setLogger: () => {},
        isWarm: () => false,
        warmup: async () => {
          warmCalls++;
        },
        checkFile: () => {
          throw new Error("checkFile must not run on a cold server");
        },
      } as unknown as LspClient;

      const module = new LspModule(CONFIG, client);
      const result = { success: true, output: "" } as never;
      const started = Date.now();
      await module.getPlugin().onAfterTool?.(ctxFor(dir), writeCall("src/a.ts"), result);

      expect(Date.now() - started).toBeLessThan(500);
      expect(warmCalls).toBe(1);
      expect((result as { output: string }).output).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checks immediately when the connection is warm", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-lsp-warm-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "b.ts"), "export const b = 1;\n");

      let checked = 0;
      let receivedTimeout = 0;
      const client = {
        setOffline: () => {},
        setLogger: () => {},
        isWarm: () => true,
        warmup: async () => {},
        checkFile: async (
          _file: string,
          _base: string,
          _cfg: unknown,
          _root: string,
          timeoutMs?: number,
        ) => {
          checked++;
          receivedTimeout = timeoutMs ?? 0;
          return { diagnostics: [], inconclusive: false };
        },
      } as unknown as LspClient;

      const module = new LspModule(CONFIG, client);
      const result = { success: true, output: "" } as never;
      await module.getPlugin().onAfterTool?.(ctxFor(dir), writeCall("src/b.ts"), result);

      expect(checked).toBe(1);
      // Пост-проверка не ждёт 30-секундный таймаут сервера (аудит §8.2).
      expect(receivedTimeout).toBeGreaterThan(0);
      expect(receivedTimeout).toBeLessThanOrEqual(5000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
