import { describe, it, expect, afterEach } from "vitest";
import { DEFAULTS } from "../src/config/defaults";
import { loadConfig } from "../src/config/config";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("config defaults", () => {
  it("should have version field", () => {
    expect(DEFAULTS.version).toBe("2.0.0");
  });

  it("should have all required fields", () => {
    expect(DEFAULTS.model).toBe("qwen/qwen3.5-9b");
    expect(DEFAULTS.provider.type).toBe("openai-compat");
    expect(DEFAULTS.provider.baseUrl).toBe("http://localhost:1234/v1");
    expect(DEFAULTS.provider.apiKey).toBe("not-needed");
    expect(DEFAULTS.contextWindow).toBe(32768);
    expect(DEFAULTS.maxToolIterations).toBe(1000);
    expect(DEFAULTS.stuckThreshold).toBe(6);
    expect(DEFAULTS.autoPlan).toBe(true);
    expect(DEFAULTS.logLevel).toBe("info");
    expect(DEFAULTS.locale).toBe("en");
  });

  it("should have context budget defaults", () => {
    expect(DEFAULTS.contextBudget.systemPrompt).toBe(0.1);
    expect(DEFAULTS.contextBudget.responseReserve).toBe(0.15);
    expect(DEFAULTS.contextBudget.compactionThreshold).toBe(0.75);
  });

  it("should have orchestrator undefined by default", () => {
    expect(DEFAULTS.orchestrator.model).toBeUndefined();
    expect(DEFAULTS.orchestrator.provider).toBeUndefined();
  });
});

describe("subagent defaults", () => {
  it("keeps backward-compatible defaults", () => {
    expect(DEFAULTS.subagent.resultMode).toBe("text");
    expect(DEFAULTS.subagent.maxSummaryChars).toBe(2000);
    expect(DEFAULTS.subagent.artifactsDir).toBe(".mma/artifacts");
    expect(DEFAULTS.subagent.stableSystemPrompt).toBe(true);
    expect(DEFAULTS.subagent.maxParallelChunkQueries).toBe(4);
  });
});

describe("loadConfig", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) {
      try {
        rmSync(d, { recursive: true });
      } catch {}
    }
    tmpDirs.length = 0;
  });

  function makeTempDir(): string {
    const d = mkdtempSync(join(tmpdir(), "mma-test-"));
    tmpDirs.push(d);
    return d;
  }

  it("should return defaults when no files exist", () => {
    const tmpDir = makeTempDir();
    const cfg = loadConfig({
      configDir: tmpDir,
      projectConfigPath: join(tmpDir, ".mmrc"),
    });
    expect(cfg.model).toBe("qwen/qwen3.5-9b");
  });

  it("should merge global config", () => {
    const tmpDir = makeTempDir();
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        version: "2.0.0",
        model: "test-model",
        provider: {
          type: "openai-compat",
          baseUrl: "http://localhost:1234/v1",
        },
        contextWindow: 32768,
        contextBudget: {
          systemPrompt: 0.1,
          responseReserve: 0.15,
          compactionThreshold: 0.75,
        },
      }),
    );
    const cfg = loadConfig({
      configDir: tmpDir,
      projectConfigPath: join(tmpDir, ".mmrc"),
    });
    expect(cfg.model).toBe("test-model");
    expect(cfg.provider.baseUrl).toBe("http://localhost:1234/v1");
  });

  it("should merge project .mmrc over global", () => {
    const tmpDir = makeTempDir();
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        version: "2.0.0",
        model: "global-model",
        provider: {
          type: "openai-compat",
          baseUrl: "http://localhost:1234/v1",
        },
        contextWindow: 32768,
        contextBudget: {
          systemPrompt: 0.1,
          responseReserve: 0.15,
          compactionThreshold: 0.75,
        },
      }),
    );
    writeFileSync(join(tmpDir, ".mmrc"), JSON.stringify({ model: "project-model" }));
    const cfg = loadConfig({
      configDir: tmpDir,
      projectConfigPath: join(tmpDir, ".mmrc"),
    });
    expect(cfg.model).toBe("project-model");
  });

  it("should apply MMA_ env vars", () => {
    const tmpDir = makeTempDir();
    const prev = process.env.MMA_MODEL;
    process.env.MMA_MODEL = "env-model";
    try {
      const cfg = loadConfig({
        configDir: tmpDir,
        projectConfigPath: join(tmpDir, ".mmrc"),
      });
      expect(cfg.model).toBe("env-model");
    } finally {
      if (prev) process.env.MMA_MODEL = prev;
      else delete process.env.MMA_MODEL;
    }
  });

  it("should handle MMA_PROVIDER_BASEURL env var", () => {
    const tmpDir = makeTempDir();
    const prev = process.env.MMA_PROVIDER_BASEURL;
    process.env.MMA_PROVIDER_BASEURL = "http://env:8080/v1";
    try {
      const cfg = loadConfig({
        configDir: tmpDir,
        projectConfigPath: join(tmpDir, ".mmrc"),
      });
      expect(cfg.provider.baseUrl).toBe("http://env:8080/v1");
    } finally {
      if (prev) process.env.MMA_PROVIDER_BASEURL = prev;
      else delete process.env.MMA_PROVIDER_BASEURL;
    }
  });

  it("should migrate v1 config on load", () => {
    const tmpDir = makeTempDir();
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        apiBase: "http://old:1234",
        model: "qwen2.5-7b",
        temperature: 0.7,
      }),
    );

    const cfg = loadConfig({
      configDir: tmpDir,
      projectConfigPath: join(tmpDir, ".mmrc"),
    });
    expect(cfg.model).toBe("qwen/qwen3.5-9b");
    expect(cfg.version).toBe("2.0.0");
    expect(existsSync(join(tmpDir, "config.json.bak"))).toBe(true);
  });

  it("normalizes stale pre-0.41.1 LSP server args to the fixed defaults", () => {
    const tmpDir = makeTempDir();
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        version: "2.0.0",
        lsp: {
          enabled: true,
          servers: {
            typescript: {
              command: "npx",
              args: ["typescript-language-server", "--stdio"],
              timeout: 20000,
              workspaceMarkers: ["package.json", "tsconfig.json"],
            },
            css: {
              command: "npx",
              args: ["vscode-css-languageserver", "--stdio"],
              timeout: 10000,
              workspaceMarkers: ["package.json"],
            },
          },
        },
      }),
    );

    const cfg = loadConfig({
      configDir: tmpDir,
      projectConfigPath: join(tmpDir, ".mmrc"),
    });
    const ts = cfg.lsp!.servers.typescript;
    const css = cfg.lsp!.servers.css;
    expect(ts.args).toEqual([
      "--yes",
      "--package",
      "typescript-language-server",
      "--package",
      "typescript@5",
      "typescript-language-server",
      "--stdio",
    ]);
    expect(ts.timeout).toBe(30000);
    expect(css.args).toEqual([
      "--yes",
      "--package",
      "vscode-langservers-extracted",
      "--package",
      "typescript@5",
      "vscode-css-language-server",
      "--stdio",
    ]);
    expect(css.timeout).toBe(60000);
  });

  it("keeps custom LSP server args that differ from the legacy form", () => {
    const tmpDir = makeTempDir();
    const customArgs = ["--experimental", "my-ts-server", "--stdio"];
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        version: "2.0.0",
        lsp: {
          enabled: true,
          servers: {
            typescript: {
              command: "npx",
              args: customArgs,
              timeout: 20000,
              workspaceMarkers: ["package.json", "tsconfig.json"],
            },
          },
        },
      }),
    );

    const cfg = loadConfig({
      configDir: tmpDir,
      projectConfigPath: join(tmpDir, ".mmrc"),
    });
    expect(cfg.lsp!.servers.typescript.args).toEqual(customArgs);
  });

  it("keeps non-npx LSP commands untouched", () => {
    const tmpDir = makeTempDir();
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        version: "2.0.0",
        lsp: {
          enabled: true,
          servers: {
            typescript: {
              command: "typescript-language-server",
              args: ["--stdio"],
              timeout: 20000,
              workspaceMarkers: ["package.json", "tsconfig.json"],
            },
          },
        },
      }),
    );

    const cfg = loadConfig({
      configDir: tmpDir,
      projectConfigPath: join(tmpDir, ".mmrc"),
    });
    expect(cfg.lsp!.servers.typescript.args).toEqual(["--stdio"]);
    expect(cfg.lsp!.servers.typescript.command).toBe("typescript-language-server");
  });
});
