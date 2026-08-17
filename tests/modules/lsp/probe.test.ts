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
});
