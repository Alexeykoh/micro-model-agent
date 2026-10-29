import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LspModule } from "../../../src/modules/lsp/module";
import type { LspClient } from "../../../src/modules/lsp/client";

/**
 * Старт сессии сам поднимает серверы проекта (один раз за процесс) и пишет
 * структурные строки в app.jsonl на уровне info. Раньше LSP молчал до первого
 * `lsp_check`/записи: пользователь видел «сервер ещё запускается» без следов в
 * логе, а сервер поднимался уже после запроса.
 */

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "mma-lsp-session-warm-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), "{}", "utf-8");
  writeFileSync(join(dir, "src/a.ts"), "export const a = 1;\n", "utf-8");
  return dir;
}

function fakeClient(warmed: string[]): LspClient {
  return {
    setOffline: () => {},
    setLogger: () => {},
    isWarm: () => false,
    warmup: async (server) => {
      warmed.push(server.command);
    },
    close: async () => {},
    liveConnections: () => 0,
    stats: () => ({ live: 0, restarts: 0, reaped: 0 }),
  } as unknown as LspClient;
}

describe("LspModule: прогрев на старте сессии", () => {
  it("warms the project once per module, not on every session event", async () => {
    const dir = project();
    try {
      const warmed: string[] = [];
      const cfg = {
        enabled: true,
        servers: { typescript: { command: "ts-ls", args: [], workspaceMarkers: ["package.json"] } },
      };
      const module = new LspModule(cfg as never, fakeClient(warmed), undefined, dir);
      const plugin = module.getPlugin();

      plugin.onSessionStart?.({});
      await new Promise((r) => setTimeout(r, 50));
      plugin.onSessionStart?.({});
      await new Promise((r) => setTimeout(r, 50));

      expect(warmed).toEqual(["ts-ls"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("logs warmup lifecycle at info level", async () => {
    const dir = project();
    try {
      const warmMsgs: string[] = [];
      const logger = {
        debug: () => {},
        warn: () => {},
        error: () => {},
        info: (msg: string) => warmMsgs.push(msg),
      };
      const cfg = {
        enabled: true,
        servers: { typescript: { command: "ts-ls", args: [], workspaceMarkers: ["package.json"] } },
      };
      const module = new LspModule(cfg as never, fakeClient([]), logger, dir);
      module.getPlugin().onSessionStart?.({});
      await new Promise((r) => setTimeout(r, 50));

      expect(warmMsgs.some((m) => m.startsWith("LSP warm project:"))).toBe(true);
      expect(warmMsgs.some((m) => m.startsWith("LSP warm start: ts-ls"))).toBe(true);
      expect(warmMsgs.some((m) => m.startsWith("LSP ready: ts-ls"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
