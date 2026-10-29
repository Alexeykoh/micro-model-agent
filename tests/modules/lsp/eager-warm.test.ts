import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { warmProjectServers, WARM_SCAN_LIMIT } from "../../../src/modules/lsp/warmup";
import { LspHealth } from "../../../src/modules/lsp/health";
import type { LspClient } from "../../../src/modules/lsp/client";
import type { LspConfig } from "../../../src/modules/lsp/types";

/**
 * Старт сессии прогревает применимые серверы в фоне. Без этого пул тёплый
 * только после первого обращения, и каждый `lsp_check`/запись в новой сессии
 * платит холодный старт 1–12 с (или упирается в бюджет ожидания).
 */

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "mma-lsp-warm-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body, "utf-8");
  }
  return dir;
}

function config(overrides: Partial<LspConfig> = {}): LspConfig {
  return {
    enabled: true,
    timeout: 15000,
    servers: {
      typescript: { command: "ts-ls", args: [], workspaceMarkers: ["package.json"] },
      css: { command: "css-ls", args: [], workspaceMarkers: ["package.json"] },
    },
    ...overrides,
  };
}

function client(warmed: string[]): Pick<LspClient, "isWarm" | "warmup"> {
  return {
    isWarm: () => false,
    warmup: async (server) => {
      warmed.push(server.command);
    },
  } as unknown as Pick<LspClient, "isWarm" | "warmup">;
}

describe("warmProjectServers", () => {
  it("warms each applicable server once and logs start/ready", async () => {
    const dir = project({
      "package.json": "{}",
      "src/a.ts": "export const a = 1;",
      "src/b.ts": "export const b = 1;",
      "src/c.css": "body { color: red; }",
    });
    try {
      const warmed: string[] = [];
      const logs: string[] = [];
      await warmProjectServers({
        config: config(),
        baseDir: dir,
        client: client(warmed),
        health: new LspHealth(),
        logger: null,
        log: (msg) => logs.push(msg),
      });

      // Два файла .ts дали один прогрев: ключ — сервер+корень проекта.
      expect(warmed).toEqual(["ts-ls", "css-ls"]);
      expect(logs.some((l) => l.includes("LSP warm start: ts-ls"))).toBe(true);
      expect(logs.some((l) => l.includes("LSP ready: ts-ls"))).toBe(true);
      expect(logs.some((l) => l.includes("LSP ready: css-ls"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips a server during its cooldown", async () => {
    const dir = project({
      "package.json": "{}",
      "src/a.ts": "export const a = 1;",
      "src/c.css": "body { color: red; }",
    });
    try {
      const warmed: string[] = [];
      const health = new LspHealth();
      const failing = { ...config().servers.typescript!, command: "ts-ls" };
      // Доводим TS до паузы восстановления.
      for (let i = 0; i < 3; i++) health.recordFailure("ts-ls:", failing, "boom");

      const logs: string[] = [];
      await warmProjectServers({
        config: config(),
        baseDir: dir,
        client: client(warmed),
        health,
        logger: null,
        log: (msg) => logs.push(msg),
      });

      expect(warmed).toEqual(["css-ls"]);
      expect(logs.some((l) => l.includes("LSP warm skipped: ts-ls"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does nothing when LSP is disabled or no files match", async () => {
    const dir = project({ "README.md": "hi" });
    try {
      const warmed: string[] = [];
      await warmProjectServers({
        config: config(),
        baseDir: dir,
        client: client(warmed),
        health: new LspHealth(),
        logger: null,
        log: () => {},
      });
      await warmProjectServers({
        config: config({ enabled: false }),
        baseDir: dir,
        client: client(warmed),
        health: new LspHealth(),
        logger: null,
        log: () => {},
      });
      expect(warmed).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records a failed warmup and reports it", async () => {
    const dir = project({ "package.json": "{}", "src/a.ts": "export const a = 1;" });
    try {
      const logs: string[] = [];
      const health = new LspHealth();
      await warmProjectServers({
        config: config(),
        baseDir: dir,
        client: {
          isWarm: () => false,
          warmup: async () => {
            throw new Error("SyntaxError: Unexpected token '?'");
          },
        } as unknown as Pick<LspClient, "isWarm" | "warmup">,
        health,
        logger: null,
        log: (msg) => logs.push(msg),
      });

      const failed = logs.find((l) => l.includes("LSP warm failed: ts-ls"));
      expect(failed).toBeDefined();
      expect(failed).toContain("SyntaxError");
      expect(health.counts().get("ts-ls:") ?? 0).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps the scan so a huge repo cannot delay the warmup forever", () => {
    expect(WARM_SCAN_LIMIT).toBeGreaterThan(0);
    expect(WARM_SCAN_LIMIT).toBeLessThanOrEqual(100);
  });
});
