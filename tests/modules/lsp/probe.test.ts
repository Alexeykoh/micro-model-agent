import { describe, expect, it, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { probeLspServers } from "../../../src/modules/lsp/probe";
import type { LspConfig } from "../../../src/modules/lsp/types";

const CONFIG: LspConfig = {
  enabled: true,
  servers: {
    typescript: {
      command: "ts-server",
      args: ["--stdio"],
      workspaceMarkers: ["tsconfig.json", "package.json"],
    },
    css: {
      command: "css-server",
      args: ["--stdio"],
      workspaceMarkers: ["package.json"],
    },
  },
  timeout: 30000,
};

describe("probeLspServers", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-lsp-probe-"));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
  });

  it("returns noneApplicable when LSP is disabled", async () => {
    const summary = await probeLspServers({ ...CONFIG, enabled: false }, tmpDir);
    expect(summary.noneApplicable).toBe(true);
    expect(summary.ok).toEqual([]);
    expect(summary.failed).toEqual([]);
  });

  it("returns noneApplicable when no project file has a configured server", async () => {
    writeFileSync(join(tmpDir, "readme.md"), "# hi");
    const summary = await probeLspServers(CONFIG, tmpDir, {
      client: { probe: async () => {} } as any,
    });
    expect(summary.noneApplicable).toBe(true);
  });

  it("probes only servers for languages present in the project", async () => {
    writeFileSync(join(tmpDir, "a.ts"), "export const a = 1;");
    writeFileSync(join(tmpDir, "package.json"), "{}");
    const probed: string[] = [];
    const summary = await probeLspServers(CONFIG, tmpDir, {
      client: {
        probe: async (server: { args?: string[] }) => {
          probed.push(server.args?.[0] ?? "");
        },
      } as any,
    });
    expect(probed).toEqual(["--stdio"]);
    expect(summary.ok).toHaveLength(1);
    expect(summary.ok[0].language).toBe("typescript");
    expect(summary.failed).toHaveLength(0);
    expect(summary.noneApplicable).toBe(false);
  });

  it("reports servers that fail to start as failed", async () => {
    writeFileSync(join(tmpDir, "a.css"), "body {}");
    writeFileSync(join(tmpDir, "package.json"), "{}");
    const summary = await probeLspServers(CONFIG, tmpDir, {
      client: {
        probe: async () => {
          throw new Error("server not found");
        },
      } as any,
    });
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0].language).toBe("css");
    expect(summary.failed[0].error).toContain("server not found");
    expect(summary.ok).toHaveLength(0);
  });

  it("honors a custom file collector", async () => {
    const summary = await probeLspServers(CONFIG, tmpDir, {
      client: { probe: async () => {} } as any,
      collectFiles: async () => [join(tmpDir, "a.css")],
    });
    expect(summary.ok).toHaveLength(1);
    expect(summary.ok[0].language).toBe("css");
  });

  it("probes in waves bounded by maxParallel", async () => {
    writeFileSync(join(tmpDir, "a.ts"), "export const a = 1;");
    writeFileSync(join(tmpDir, "b.css"), "body {}");
    writeFileSync(join(tmpDir, "package.json"), "{}");
    const threeServerConfig: LspConfig = {
      ...CONFIG,
      servers: {
        ...CONFIG.servers,
        json: {
          command: "json-server",
          args: ["--stdio"],
          workspaceMarkers: ["package.json"],
        },
      },
    };
    const active = new Set<string>();
    let peak = 0;
    const probed: string[] = [];
    const summary = await probeLspServers(threeServerConfig, tmpDir, {
      maxParallel: 2,
      client: {
        probe: async (server: { args?: string[] }) => {
          active.add(server.args?.[0] ?? "");
          peak = Math.max(peak, active.size);
          await new Promise((r) => setTimeout(r, 30));
          active.delete(server.args?.[0] ?? "");
          probed.push(server.args?.[0] ?? "");
        },
      } as any,
    });
    expect(probed).toHaveLength(3);
    expect(probed.every((p) => p === "--stdio")).toBe(true);
    expect(summary.ok).toHaveLength(3);
    expect(peak).toBeLessThanOrEqual(2);
    expect(summary.noneApplicable).toBe(false);
  });

  it("marks servers that miss the deadline as failed", async () => {
    writeFileSync(join(tmpDir, "a.ts"), "export const a = 1;");
    writeFileSync(join(tmpDir, "b.css"), "body {}");
    writeFileSync(join(tmpDir, "package.json"), "{}");
    const summary = await probeLspServers(CONFIG, tmpDir, {
      deadlineMs: 0,
      maxParallel: 1,
      client: { probe: async () => {} } as any,
    });
    expect(summary.failed).toHaveLength(2);
    expect(summary.failed.every((r) => r.error === "timeout")).toBe(true);
    expect(summary.ok).toHaveLength(0);
  });
});
