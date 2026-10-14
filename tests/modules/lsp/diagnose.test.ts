import { describe, expect, it } from "bun:test";
import {
  diagnoseLspServers,
  classifyLspError,
  installCommandFor,
  npxPackages,
} from "../../../src/modules/lsp/diagnose";
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

  it("honours config.offline when no explicit override is passed", async () => {
    const saved = process.env.MMA_LSP_OFFLINE;
    delete process.env.MMA_LSP_OFFLINE;
    try {
      const cfg: LspConfig = { ...config({ typescript: TS_SERVER }), offline: true };
      const d = await diagnoseLspServers(cfg, "C:/proj", {
        collectFiles: async () => [file("a.ts")],
        findOnPath: () => null,
      });
      expect(d.offline).toBe(true);
      expect(d.servers[0].reason).toBe("offline");
    } finally {
      if (saved !== undefined) process.env.MMA_LSP_OFFLINE = saved;
    }
  });

  it("suggests a global install for an npx-backed server that started via npx", async () => {
    const d = await diagnoseLspServers(config({ typescript: TS_SERVER }), "C:/proj", {
      collectFiles: async () => [file("a.ts")],
      findOnPath: () => null,
      client: { probe: async () => {} } as never,
    });
    expect(d.servers[0].installCommand).toBe("npm i -g typescript-language-server typescript@5");
  });

  it("pins the global install command to the project toolchain", async () => {
    const d = await diagnoseLspServers(config({ typescript: TS_SERVER }), "C:/proj", {
      collectFiles: async () => [file("a.ts")],
      findOnPath: () => null,
      client: { probe: async () => {} } as never,
      toolchain: {
        runtimes: [{ name: "node", version: "16.13.0", source: ".nvmrc" }],
        packages: { typescript: "4.1.6" },
      },
    });
    expect(d.toolchain?.packages.typescript).toBe("4.1.6");
    expect(d.servers[0].installCommand).toBe("npm i -g typescript-language-server typescript@4.1.6");
  });

  it("suggests the native installer for a missing native server", async () => {
    const rust: LspServerConfig = { command: "rust-analyzer", autoInstall: false };
    const d = await diagnoseLspServers(config({ rust }), "C:/proj", {
      collectFiles: async () => [file("main.rs")],
      findOnPath: () => null,
    });
    expect(d.servers[0].installCommand).toBe("rustup component add rust-analyzer");
  });

  it("omits the install hint when the global binary already runs", async () => {
    const d = await diagnoseLspServers(config({ typescript: TS_SERVER }), "C:/proj", {
      collectFiles: async () => [file("a.ts")],
      findOnPath: (n) => (n === "typescript-language-server" ? "/usr/bin/tls" : null),
      client: { probe: async () => {} } as never,
    });
    expect(d.servers[0].installCommand).toBeUndefined();
  });
});

describe("installCommandFor", () => {
  it("collects --package values and dedupes", () => {
    expect(npxPackages(TS_SERVER.args)).toEqual(["typescript-language-server", "typescript@5"]);
    expect(npxPackages(["--yes", "pyright", "--stdio"])).toEqual([]);
  });

  it("returns null for a healthy global server and unknown natives", () => {
    expect(installCommandFor({ command: "gopls" }, "ok", false)).toBeNull();
    expect(installCommandFor({ command: "custom-ls" }, "ok", false)).toBeNull();
    expect(installCommandFor({ command: "gopls" }, "binary-missing", false)).toBe(
      "go install golang.org/x/tools/gopls@latest",
    );
  });

  it("pins npm packages to the project's declared versions", () => {
    expect(
      installCommandFor(TS_SERVER, "network", true, {
        runtimes: [],
        packages: { typescript: "4.1.6" },
      }),
    ).toBe("npm i -g typescript-language-server typescript@4.1.6");
  });

  it("adds the project's rust channel to the native installer", () => {
    expect(
      installCommandFor({ command: "rust-analyzer" }, "binary-missing", false, {
        runtimes: [{ name: "rust", version: "1.65.0", source: "rust-toolchain" }],
        packages: {},
      }),
    ).toBe("rustup component add rust-analyzer --toolchain 1.65.0");
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
