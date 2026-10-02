import { describe, expect, it } from "bun:test";
import { diagnoseLspServers, classifyLspError } from "../../../src/modules/lsp/diagnose";
import type { LspConfig, LspServerConfig } from "../../../src/modules/lsp/types";

const TS_SERVER: LspServerConfig = {
  command: "npx",
  args: [
    "--yes",
    "--package",
    "typescript-language-server",
    "--package",
    "typescript@5",
    "typescript-language-server",
    "--stdio",
  ],
  timeout: 30000,
  workspaceMarkers: ["package.json"],
};

function config(servers: Record<string, LspServerConfig>, enabled = true): LspConfig {
  return { enabled, timeout: 15000, servers };
}

const file = (name: string) => `C:/proj/${name}`;

describe("diagnoseLspServers", () => {
  it("marks every server disabled when LSP is off globally", async () => {
    const d = await diagnoseLspServers(config({ typescript: TS_SERVER }, false), "C:/proj");
    expect(d.enabled).toBe(false);
    expect(d.servers.every((s) => s.reason === "disabled")).toBe(true);
  });

  it("skips servers with no matching project files", async () => {
    const d = await diagnoseLspServers(config({ typescript: TS_SERVER }), "C:/proj", {
      collectFiles: async () => [],
    });
    expect(d.servers[0].reason).toBe("not-applicable");
    expect(d.servers[0].probed).toBe(false);
  });

  it("reports binary-missing for a native server absent from PATH", async () => {
    const rust: LspServerConfig = { command: "rust-analyzer", autoInstall: false };
    const d = await diagnoseLspServers(config({ rust }), "C:/proj", {
      collectFiles: async () => [file("main.rs")],
      findOnPath: () => null,
    });
    expect(d.servers[0]).toMatchObject({ reason: "binary-missing", applicable: true, probed: false });
  });

  it("reports offline and does not probe when npx would be needed", async () => {
    let probed = false;
    const d = await diagnoseLspServers(config({ typescript: TS_SERVER }), "C:/proj", {
      collectFiles: async () => [file("a.ts")],
      findOnPath: () => null,
      offline: true,
      client: { probe: async () => { probed = true; } } as never,
    });
    expect(d.offline).toBe(true);
    expect(d.servers[0].reason).toBe("offline");
    expect(probed).toBe(false);
  });

  it("reports ok with duration when the server starts", async () => {
    const d = await diagnoseLspServers(config({ typescript: TS_SERVER }), "C:/proj", {
      collectFiles: async () => [file("a.ts")],
      findOnPath: (n) => (n === "typescript-language-server" ? "/usr/bin/tls" : null),
      client: { probe: async () => {} } as never,
    });
    expect(d.servers[0]).toMatchObject({ reason: "ok", ok: true, probed: true });
    expect(d.servers[0].useNpxFallback).toBe(false);
    expect(typeof d.servers[0].durationMs).toBe("number");
  });

  it("classifies an npx initialize timeout as network", async () => {
    const d = await diagnoseLspServers(config({ typescript: TS_SERVER }), "C:/proj", {
      collectFiles: async () => [file("a.ts")],
      findOnPath: () => null,
      client: { probe: async () => { throw new Error("LSP request timeout: initialize"); } } as never,
    });
    expect(d.servers[0]).toMatchObject({ reason: "network", useNpxFallback: true });
  });

  it("classifies a native initialize timeout as timeout (no npx)", async () => {
    const rust: LspServerConfig = { command: "rust-analyzer" };
    const d = await diagnoseLspServers(config({ rust }), "C:/proj", {
      collectFiles: async () => [file("main.rs")],
      findOnPath: () => "/usr/bin/rust-analyzer",
      client: { probe: async () => { throw new Error("LSP request timeout: initialize"); } } as never,
    });
    expect(d.servers[0].reason).toBe("timeout");
  });

  it("classifies a spawn error", async () => {
    const rust: LspServerConfig = { command: "rust-analyzer" };
    const d = await diagnoseLspServers(config({ rust }), "C:/proj", {
      collectFiles: async () => [file("main.rs")],
      findOnPath: () => "/usr/bin/rust-analyzer",
      client: { probe: async () => { throw new Error("spawn rust-analyzer ENOENT"); } } as never,
    });
    expect(d.servers[0].reason).toBe("spawn-failed");
  });

  it("marks servers beyond the deadline", async () => {
    const d = await diagnoseLspServers(config({ typescript: TS_SERVER }), "C:/proj", {
      collectFiles: async () => [file("a.ts")],
      findOnPath: () => "/usr/bin/tls",
      deadlineMs: -1,
      client: { probe: async () => {} } as never,
    });
    expect(d.servers[0].reason).toBe("deadline");
  });
});

describe("classifyLspError", () => {
  it("maps messages to reasons", () => {
    expect(classifyLspError("npx not found in PATH")).toBe("binary-missing");
    expect(classifyLspError("npx auto-install is disabled (MMA_LSP_OFFLINE)")).toBe("offline");
    expect(classifyLspError("spawn EINVAL")).toBe("spawn-failed");
    expect(classifyLspError("LSP request timeout: initialize", { npxFallback: true })).toBe("network");
    expect(classifyLspError("LSP request timeout: initialize")).toBe("timeout");
    expect(classifyLspError("something broke")).toBe("server-error");
  });
});
