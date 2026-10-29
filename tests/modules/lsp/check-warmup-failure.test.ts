import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LspModule } from "../../../src/modules/lsp/module";
import { setLocale } from "../../../src/i18n/index";
import type { LspClient } from "../../../src/modules/lsp/client";
import type { ToolContext } from "../../../src/tools/types";

/**
 * Упавший прогрев — это падение сервера, а не «ещё запускается». Живой случай:
 * Node 16 + `typescript-language-server` 4+ падает с `SyntaxError` до
 * `initialize`, а `lsp_check` на каждой проверке отвечал «ждите холодный старт»,
 * `/lsp status` показывал «все серверы работают», и причина не всплывала нигде.
 */

setLocale("en");

// Локаль — процесс-глобальная: другой файл в том же прогоне может выставить ru,
// и проверки английских строк станут ложно-красными.
beforeEach(() => setLocale("en"));

const CONFIG = {
  enabled: true,
  servers: {
    typescript: { command: "tsgo", args: ["--lsp"], workspaceMarkers: [], timeout: 50 },
  },
};

function ctxFor(baseDir: string): ToolContext {
  return {
    baseDir,
    config: {} as never,
    logger: { info: () => {}, error: () => {}, warn: () => {} },
  } as unknown as ToolContext;
}

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "mma-lsp-warm-fail-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/a.ts"), "export const a = 1;\n", "utf-8");
  return dir;
}

function crashingClient(): LspClient {
  return {
    setOffline: () => {},
    setLogger: () => {},
    isWarm: () => false,
    warmup: async () => {
      throw new Error("SyntaxError: Unexpected token '?'");
    },
    checkFile: () => {
      throw new Error("checkFile must not run when the server crashed");
    },
  } as unknown as LspClient;
}

describe("lsp_check: прогрев упал", () => {
  it("reports the failure instead of a cold start", async () => {
    const dir = project();
    try {
      const module = new LspModule(CONFIG, crashingClient());
      const result = await module.getToolDefinitions()[0].handler(ctxFor(dir), { path: "src/a.ts" });

      expect(result.success).toBe(false);
      expect(result.output).toContain("[LSP check failed for");
      expect(result.output).toContain("SyntaxError");
      // Никакого «сервер ещё запускается» — это не холодный старт.
      expect(result.output).not.toContain("still starting");
      // Падение учтено: `/lsp status` больше не скажет «все серверы работают».
      expect(module.getFailureCounts().size).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("disables a server that keeps crashing after the threshold", async () => {
    const dir = project();
    try {
      const module = new LspModule(CONFIG, crashingClient());
      const handler = module.getToolDefinitions()[0].handler;
      for (let i = 0; i < 3; i++) {
        await handler(ctxFor(dir), { path: "src/a.ts" });
      }
      expect(module.isLspDisabled()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shows the crashed server's stderr and names the real cause", async () => {
    const dir = project();
    try {
      const client = {
        setOffline: () => {},
        setLogger: () => {},
        isWarm: () => false,
        warmup: async () => {
          // Так выглядит крах на неподходящем Node: клиент видит «exited»,
          // причина — только в stderr.
          throw Object.assign(new Error("LSP server exited"), {
            stderrTail:
              "SyntaxError: Unexpected token '?'\n    at wrapSafe\n    at Module._compile\n    at Module._load",
          });
        },
        checkFile: () => {
          throw new Error("checkFile must not run when the server crashed");
        },
      } as unknown as LspClient;
      const module = new LspModule(CONFIG, client);
      const result = await module.getToolDefinitions()[0].handler(ctxFor(dir), { path: "src/a.ts" });

      // Хвост stderr в отчёте: начало + конец (фатальная строка), середина
      // схлопывается — иначе предупреждения вытесняют причину падения.
      expect(result.output).toContain("SyntaxError: Unexpected token '?'");
      expect(result.output).toContain("at Module._load");
      expect(result.output).not.toContain("at wrapSafe");
      // Классификация учитывает stderr: подсказка про версию Node, а не сеть.
      expect(result.output).toContain("crashes on startup");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips a server during its cooldown and says when it will retry", async () => {
    const dir = project();
    try {
      let warmups = 0;
      const client = {
        setOffline: () => {},
        setLogger: () => {},
        isWarm: () => false,
        warmup: async () => {
          warmups++;
          throw new Error("LSP server exited");
        },
        checkFile: () => {
          throw new Error("checkFile must not run when the server crashed");
        },
      } as unknown as LspClient;
      const module = new LspModule(CONFIG, client);
      const handler = module.getToolDefinitions()[0].handler;
      for (let i = 0; i < 3; i++) await handler(ctxFor(dir), { path: "src/a.ts" });
      expect(module.isLspDisabled()).toBe(true);
      const attempts = warmups;

      const paused = await handler(ctxFor(dir), { path: "src/a.ts" });
      expect(warmups).toBe(attempts);
      expect(paused.output).toContain("cooldown");
      expect(paused.output).toContain("next attempt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not report a cold start when the server died right after initialize", async () => {
    const dir = project();
    try {
      const client = {
        setOffline: () => {},
        setLogger: () => {},
        // Прогрев «успешен», но соединения нет: процесс поднялся и умер.
        isWarm: () => false,
        warmup: async () => {},
        checkFile: () => {
          throw new Error("checkFile must not run on a dead server");
        },
      } as unknown as LspClient;
      const module = new LspModule(CONFIG, client);
      const result = await module.getToolDefinitions()[0].handler(ctxFor(dir), { path: "src/a.ts" });

      expect(result.success).toBe(false);
      expect(result.output).toContain("exited immediately after initialize");
      // Не «ещё запускается»: иначе панель повторяет запрос и поднимает сервер
      // каждые 2 секунды, пока не истечёт минута.
      expect(result.output).not.toContain("still starting");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the cold-start message for a warmup that is still running", async () => {    const dir = project();
    try {
      const client = {
        setOffline: () => {},
        setLogger: () => {},
        isWarm: () => false,
        warmup: () => new Promise<void>(() => {}),
        checkFile: () => {
          throw new Error("checkFile must not run on a cold server");
        },
      } as unknown as LspClient;
      const module = new LspModule(CONFIG, client);
      const result = await module.getToolDefinitions()[0].handler(ctxFor(dir), { path: "src/a.ts" });

      expect(result.output).toContain("still starting");
      expect(result.output).not.toContain("[LSP check failed for");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
