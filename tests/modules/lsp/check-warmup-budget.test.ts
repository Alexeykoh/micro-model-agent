import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runCheckFiles } from "../../../src/modules/lsp/check-run";
import { LspHealth } from "../../../src/modules/lsp/health";
import type { LspClient } from "../../../src/modules/lsp/client";
import type { LspConfig } from "../../../src/modules/lsp/types";

/**
 * Явная проверка (`lsp_check`, панель) ждёт холодный старт до 15 с, а не 4:
 * `initialize` Next.js-подпроекта в монолите (`my-app/app/page.tsx`) в 4 с не
 * укладывался, и пользователь получал «сервер ещё запускается» на каждой
 * попытке. Ожидание при этом не превышает бюджет самого вызова: пакетная
 * проверка изменённых файлов передаёт свои 6 с.
 */

const CONFIG: LspConfig = {
  enabled: true,
  timeout: 30000,
  servers: {
    typescript: { command: "fake", args: [], workspaceMarkers: [], timeout: 30000 },
  },
};

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "mma-lsp-warm-budget-"));
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n", "utf-8");
  return dir;
}

function deps(dir: string, client: LspClient, overrides: { timeoutMs?: number } = {}) {
  return {
    baseDir: dir,
    config: CONFIG,
    client,
    health: new LspHealth(),
    logger: null,
    ...overrides,
    failureNote: (key: string, _cfg: unknown, message: string) => `[failed ${key}: ${message}]`,
  };
}

/** Клиент, у которого сервер поднимается за `initMs`; проверка потом проходит. */
function slowClient(initMs: number): LspClient {
  let warm = false;
  return {
    isWarm: () => warm,
    warmup: () =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          warm = true;
          resolve();
        }, initMs);
      }),
    checkFile: async () => ({ diagnostics: [], inconclusive: false }),
  } as unknown as LspClient;
}

describe("lsp_check: бюджет холодного старта", () => {
  it("waits out a cold start longer than the old 4s budget", async () => {
    const dir = project();
    try {
      const client = slowClient(4300);
      const started = Date.now();
      const acc = await runCheckFiles([join(dir, "a.ts")], deps(dir, client));

      expect(acc.cold).toBe(0);
      expect(acc.checked).toBe(1);
      expect(Date.now() - started).toBeGreaterThan(4000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it("never waits longer than the caller's own budget", async () => {
    const dir = project();
    try {
      // Пакетная проверка панели передаёт короткий пер-файловый бюджет.
      const acc = await runCheckFiles([join(dir, "a.ts")], deps(dir, slowClient(500), { timeoutMs: 100 }));

      expect(acc.cold).toBe(1);
      expect(acc.checked).toBe(0);
      expect(acc.notes).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not wait at all when the server is already warm", async () => {
    const dir = project();
    try {
      const acc = await runCheckFiles([join(dir, "a.ts")], deps(dir, slowClient(0)));
      expect(acc.checked).toBe(1);
      expect(acc.cold).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
