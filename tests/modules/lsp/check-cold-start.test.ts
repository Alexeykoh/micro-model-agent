import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LspModule } from "../../../src/modules/lsp/module";
import { setLocale } from "../../../src/i18n/index";
import type { LspClient } from "../../../src/modules/lsp/client";
import type { ToolContext } from "../../../src/tools/types";

/**
 * `lsp_check` на холодном сервере не висит весь серверный таймаут (30 с, живая
 * сессия `ses_mvoac9q9`: `dur=30018 мс`, ответ «неокончателен»). Бюджет прогрева
 * ограничен, прогреваем в фоне, а непроверенные файлы называем честно.
 */

setLocale("en");

/** Таймаут сервера занижен, чтобы бюджет прогрева в тесте был短. */
const CONFIG = {
  enabled: true,
  servers: {
    typescript: { command: "tsgo", args: ["--lsp"], workspaceMarkers: [], timeout: 20 },
  },
};

function ctxFor(baseDir: string): ToolContext {
  return {
    baseDir,
    config: {} as never,
    logger: { info: () => {}, error: () => {}, warn: () => {} },
  } as unknown as ToolContext;
}

function project(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "mma-lsp-cold-check-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  for (const f of files) writeFileSync(join(dir, f), "export const a = 1;\n", "utf-8");
  return dir;
}

describe("lsp_check: холодный старт", () => {
  it("does not wait out the cold start — says so and returns fast", async () => {
    const dir = project(["src/a.ts"]);
    try {
      let warmupCalls = 0;
      const client = { setOffline: () => {}, setLogger: () => {},
        isWarm: () => false,
        warmup: () => {
          warmupCalls++;
          return new Promise<void>(() => {}); // сервер стартует «вечно»
        },
        checkFile: () => {
          throw new Error("checkFile must not run on a cold server");
        },
      } as unknown as LspClient;

      const module = new LspModule(CONFIG, client);
      const started = Date.now();
      const result = await module.getToolDefinitions()[0].handler(ctxFor(dir), { path: "src/a.ts" });

      expect(Date.now() - started).toBeLessThan(2000);
      expect(warmupCalls).toBe(1);
      expect(result.success).toBe(false);
      // Причина названа: сервер ещё стартует, а не «ошибок нет».
      expect(result.output).toContain("still starting");
      expect(result.output).not.toContain("No errors or warnings");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checks as soon as the warmup fits the budget", async () => {
    const dir = project(["src/b.ts"]);
    try {
      let warm = false;
      let checked = 0;
      const client = { setOffline: () => {}, setLogger: () => {},
        isWarm: () => warm,
        warmup: async () => {
          warm = true;
        },
        checkFile: async () => {
          checked++;
          return { diagnostics: [], inconclusive: false };
        },
      } as unknown as LspClient;

      const module = new LspModule(CONFIG, client);
      const result = await module.getToolDefinitions()[0].handler(ctxFor(dir), { path: "src/b.ts" });

      expect(checked).toBe(1);
      expect(result.success).toBe(true);
      expect(result.output).toContain("No errors or warnings");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bounds the per-file check on a warm server", async () => {
    const dir = project(["src/c.ts"]);
    try {
      let received = 0;
      const client = { setOffline: () => {}, setLogger: () => {},
        isWarm: () => true,
        warmup: async () => {},
        checkFile: async (
          _file: string,
          _base: string,
          _cfg: unknown,
          _root: string,
          timeoutMs?: number,
        ) => {
          received = timeoutMs ?? 0;
          return { diagnostics: [], inconclusive: false };
        },
      } as unknown as LspClient;

      const module = new LspModule(CONFIG, client);
      await module.getToolDefinitions()[0].handler(ctxFor(dir), { path: "src/c.ts" });
      expect(received).toBeGreaterThan(0);
      expect(received).toBeLessThanOrEqual(8000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
