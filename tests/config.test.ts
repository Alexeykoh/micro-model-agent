import { describe, it, expect, afterEach } from "vitest";
import { DEFAULTS } from "../src/config/defaults";
import { loadConfig, deepMerge, saveConfig } from "../src/config/config";
import { defaultOutputBus } from "../src/output";
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from "fs";
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

  it("defaults session.autoName to true", () => {
    expect(DEFAULTS.session.autoName).toBe(true);
  });

  it("defaults critic to enabled with bounded loops", () => {
    expect(DEFAULTS.critic).toEqual({
      enabled: true,
      provider: undefined,
      model: undefined,
      tools: true,
      maxCalls: 4,
      maxRepairCycles: 1,
      timeoutMs: 15000,
    });
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

describe("web search defaults", () => {
  it("enables web search and error web search by default", () => {
    expect(DEFAULTS.webSearch?.enabled).toBe(true);
    expect(DEFAULTS.errorWebSearch?.enabled).toBe(true);
    expect(DEFAULTS.errorWebSearch?.threshold).toBe(5);
    expect(DEFAULTS.errorWebSearch?.maxResults).toBe(5);
    expect(DEFAULTS.errorWebSearch?.maxQueryChars).toBe(200);
    expect(DEFAULTS.errorWebSearch?.maxSearchesPerSession).toBe(3);
    expect(DEFAULTS.errorWebSearch?.requestTimeoutMs).toBe(10000);
  });
});

describe("pricing defaults", () => {
  it("enables pricing with empty overrides by default", () => {
    expect(DEFAULTS.pricing?.enabled).toBe(true);
    expect(DEFAULTS.pricing?.overrides).toEqual({});
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
    const { config: cfg } = loadConfig({
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
    const { config: cfg } = loadConfig({
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
    const { config: cfg } = loadConfig({
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
      const { config: cfg } = loadConfig({
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
      const { config: cfg } = loadConfig({
        configDir: tmpDir,
        projectConfigPath: join(tmpDir, ".mmrc"),
      });
      expect(cfg.provider.baseUrl).toBe("http://env:8080/v1");
    } finally {
      if (prev) process.env.MMA_PROVIDER_BASEURL = prev;
      else delete process.env.MMA_PROVIDER_BASEURL;
    }
  });

  it("should apply MMA_PROVIDER_BASEURL to the ACTIVE entry when entries exist", () => {
    const tmpDir = makeTempDir();
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        version: "2.0.0",
        provider: {
          active: "main",
          entries: [
            { type: "openai-compat", label: "main", baseUrl: "http://main:8000/v1" },
            { type: "openrouter", label: "fallback", baseUrl: "http://secondary:9000/v1" },
          ],
        },
      }),
    );
    const prev = process.env.MMA_PROVIDER_BASEURL;
    process.env.MMA_PROVIDER_BASEURL = "http://env:8080/v1";
    try {
      const { config: cfg } = loadConfig({
        configDir: tmpDir,
        projectConfigPath: join(tmpDir, ".mmrc"),
      });
      // Flat field is set AND the active entry is patched — the flat field alone
      // is ignored by normalizeEntries, so without this the override is a no-op.
      expect(cfg.provider.baseUrl).toBe("http://env:8080/v1");
      expect(cfg.provider.entries![0].baseUrl).toBe("http://env:8080/v1");
      // The fallback entry is left untouched.
      expect(cfg.provider.entries![1].baseUrl).toBe("http://secondary:9000/v1");
    } finally {
      if (prev) process.env.MMA_PROVIDER_BASEURL = prev;
      else delete process.env.MMA_PROVIDER_BASEURL;
    }
  });

  it("does NOT persist MMA_ env override values into domain files on save (C4)", () => {
    const tmpDir = makeTempDir();
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        version: "2.0.0",
        model: "orig-model",
        provider: {
          type: "openai-compat",
          baseUrl: "http://orig:1234/v1",
          apiKey: "orig-key",
        },
      }),
    );
    const prev = process.env.MMA_PROVIDER_BASEURL;
    const prevModel = process.env.MMA_MODEL;
    process.env.MMA_PROVIDER_BASEURL = "http://env:8080/v1";
    process.env.MMA_MODEL = "env-model";
    try {
      const { config: cfg } = loadConfig({
        configDir: tmpDir,
        projectConfigPath: join(tmpDir, ".mmrc"),
      });
      // Env override is active in memory…
      expect(cfg.model).toBe("env-model");
      expect(cfg.provider.baseUrl).toBe("http://env:8080/v1");

      // …but a save persists the ORIGINAL user values.
      saveConfig(cfg, join(tmpDir, "config.json"), tmpDir);
      const persistedCore = JSON.parse(readFileSync(join(tmpDir, "config", "core.json"), "utf-8"));
      const persistedProvider = JSON.parse(
        readFileSync(join(tmpDir, "config", "provider.json"), "utf-8"),
      );
      expect(persistedCore.model).toBe("orig-model");
      expect(persistedProvider.provider.baseUrl).toBe("http://orig:1234/v1");
    } finally {
      if (prev) process.env.MMA_PROVIDER_BASEURL = prev;
      else delete process.env.MMA_PROVIDER_BASEURL;
      if (prevModel) process.env.MMA_MODEL = prevModel;
      else delete process.env.MMA_MODEL;
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

    const { config: cfg } = loadConfig({
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

    const { config: cfg } = loadConfig({
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

    const { config: cfg } = loadConfig({
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

    const { config: cfg } = loadConfig({
      configDir: tmpDir,
      projectConfigPath: join(tmpDir, ".mmrc"),
    });
    expect(cfg.lsp!.servers.typescript.args).toEqual(["--stdio"]);
    expect(cfg.lsp!.servers.typescript.command).toBe("typescript-language-server");
  });
});

describe("stale security config normalization", () => {
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

  const LEGACY_SECURITY = {
    enabled: false,
    bash: {
      enabled: false,
      blacklist: ["rm", "dd", "chmod", "wget", "curl"],
      whitelist: [],
      blockDangerousFlags: false,
      logCommands: true,
      dangerousFlags: ["--force", "-rf"],
      dangerousOperators: [">", ">>", "2>", "2>>", "`"],
    },
  };

  it("keeps a legacy disabled security section untouched (explicit opt-out)", () => {
    // ses_mt4fn58c post-mortem: silently force-upgrading a stored
    // enabled:false section overrode an explicit user choice and broke
    // legit workflows (npm init -y, bun run build) mid-session.
    const tmpDir = makeTempDir();
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({ version: "2.0.0", security: LEGACY_SECURITY }),
    );
    const { config: cfg } = loadConfig({
      configDir: tmpDir,
      projectConfigPath: join(tmpDir, ".mmrc"),
    });
    expect(cfg.security.enabled).toBe(false);
    expect(cfg.security.bash.enabled).toBe(false);
    expect(cfg.security.bash.blockDangerousFlags).toBe(false);
  });

  it("applies current defaults (security on) when no security section exists", () => {
    const tmpDir = makeTempDir();
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({ version: "2.0.0" }));
    const { config: cfg } = loadConfig({
      configDir: tmpDir,
      projectConfigPath: join(tmpDir, ".mmrc"),
    });
    expect(cfg.security.enabled).toBe(true);
    expect(cfg.security.bash.blockDangerousFlags).toBe(true);
  });

  it("keeps explicitly customized security config untouched", () => {
    const tmpDir = makeTempDir();
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        version: "2.0.0",
        security: {
          ...LEGACY_SECURITY,
          bash: { ...LEGACY_SECURITY.bash, blacklist: ["my-custom-cmd"] },
        },
      }),
    );
    const { config: cfg } = loadConfig({
      configDir: tmpDir,
      projectConfigPath: join(tmpDir, ".mmrc"),
    });
    expect(cfg.security.enabled).toBe(false);
    expect(cfg.security.bash.blacklist).toContain("my-custom-cmd");
  });

  it("warns and falls back to defaults on a corrupt config.json (does not delete it)", () => {
    const tmpDir = makeTempDir();
    const corruptPath = join(tmpDir, "config.json");
    writeFileSync(corruptPath, '{ "version": "2.0.0", "model": "broken", ');
    const warnings: string[] = [];
    const unsub = defaultOutputBus.subscribe((ev) => {
      if (ev.level === "warn") warnings.push(ev.text);
    });

    const { config: cfg } = loadConfig({
      configDir: tmpDir,
      projectConfigPath: join(tmpDir, ".mmrc"),
    });
    unsub();

    // Falls back to defaults, keeps the file, and is no longer silent.
    expect(cfg.model).toBe("qwen/qwen3.5-9b");
    expect(existsSync(corruptPath)).toBe(true);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("deepMerge preserves RegExp values by reference instead of destroying them", () => {
    const target = { nested: { pattern: /abc/gi } };
    const source = { nested: { other: 1 } };
    const merged = deepMerge(target, source);
    // The RegExp from target survives (is not spread into {}).
    expect((merged.nested as any).pattern).toBeInstanceOf(RegExp);
    expect((merged.nested as any).pattern.source).toBe("abc");
    expect((merged.nested as any).other).toBe(1);

    // A RegExp in the SOURCE is also preserved by reference.
    const re = /def/i;
    const merged2 = deepMerge({}, { pattern: re });
    expect((merged2 as any).pattern).toBe(re);
  });
});
