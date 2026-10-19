import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { DEFAULTS } from "../src/config/defaults";
import { loadConfig, saveConfig } from "../src/config/config";
import {
  CONFIG_DOMAINS,
  extractDomain,
  hasDomainFiles,
  loadDomainFiles,
  saveDomainFiles,
  getDomainFilePath,
  domainForKey,
} from "../src/config/domains";
import type { AppConfig } from "../src/config/types";

describe("domains.ts — CONFIG_DOMAINS mapping", () => {
  it("covers all AppConfig keys", () => {
    const allKeys = new Set<string>();
    for (const keys of Object.values(CONFIG_DOMAINS)) {
      for (const k of keys) allKeys.add(k);
    }
    // Every top-level key in AppConfig must be in some domain
    const appConfigKeys = Object.keys(DEFAULTS) as string[];
    for (const key of appConfigKeys) {
      expect(allKeys.has(key)).toBe(true);
    }
  });

  it("has no duplicate keys across domains", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const [domain, keys] of Object.entries(CONFIG_DOMAINS)) {
      for (const k of keys) {
        if (seen.has(k)) dupes.push(`${k} in ${domain}`);
        seen.add(k);
      }
    }
    expect(dupes).toEqual([]);
  });

  it("has 16 domains", () => {
    expect(Object.keys(CONFIG_DOMAINS)).toHaveLength(16);
  });
});

describe("domains.ts — extractDomain", () => {
  it("extracts core domain from full config", () => {
    const core = extractDomain(DEFAULTS, "core");
    expect(core.model).toBe(DEFAULTS.model);
    expect(core.locale).toBe(DEFAULTS.locale);
    expect(core.contextWindow).toBe(DEFAULTS.contextWindow);
    expect(core.maxToolIterations).toBe(DEFAULTS.maxToolIterations);
    expect(core).not.toHaveProperty("provider");
    expect(core).not.toHaveProperty("security");
  });

  it("extracts security domain", () => {
    const sec = extractDomain(DEFAULTS, "security");
    expect(sec.security).toBe(DEFAULTS.security);
    expect(Object.keys(sec)).toEqual(["security"]);
  });

  it("returns empty object for unknown domain", () => {
    expect(extractDomain(DEFAULTS, "nonexistent")).toEqual({});
  });
});

describe("domains.ts — getDomainFilePath", () => {
  it("returns correct path", () => {
    // join() normalizes separators to the platform (win32 → backslashes),
    // so compare against join() output instead of a literal POSIX path.
    expect(getDomainFilePath("/home/user/.mma", "core")).toBe(
      join("/home/user/.mma", "config", "core.json"),
    );
  });
});

describe("domains.ts — domainForKey", () => {
  it("maps model to core", () => {
    expect(domainForKey("model")).toBe("core");
  });

  it("maps provider to provider domain", () => {
    expect(domainForKey("provider")).toBe("provider");
  });

  it("maps security to security domain", () => {
    expect(domainForKey("security")).toBe("security");
  });

  it("maps mcpServers to mcp domain", () => {
    expect(domainForKey("mcpServers")).toBe("mcp");
  });

  it("returns null for unknown key", () => {
    expect(domainForKey("unknownKey")).toBeNull();
  });
});

describe("domains.ts — saveDomainFiles + loadDomainFiles round-trip", () => {
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
    const d = mkdtempSync(join(tmpdir(), "mma-domains-"));
    tmpDirs.push(d);
    return d;
  }

  it("creates 15 domain files", () => {
    const tmpDir = makeTempDir();
    saveDomainFiles(DEFAULTS, tmpDir);
    const configDir = join(tmpDir, "config");
    expect(existsSync(configDir)).toBe(true);
    const files = readdirSync(configDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(16);
    expect(files).toContain("core.json");
    expect(files).toContain("security.json");
    expect(files).toContain("provider.json");
    expect(files).toContain("lsp.json");
    expect(files).toContain("plugins.json");
  });

  it("each domain file contains only its keys", () => {
    const tmpDir = makeTempDir();
    saveDomainFiles(DEFAULTS, tmpDir);
    for (const [domain, keys] of Object.entries(CONFIG_DOMAINS)) {
      const filePath = getDomainFilePath(tmpDir, domain);
      const data = JSON.parse(readFileSync(filePath, "utf-8"));
      const fileKeys = Object.keys(data);
      expect(fileKeys.sort()).toEqual([...keys].sort());
    }
  });

  it("round-trips: save → load produces identical config", () => {
    const tmpDir = makeTempDir();
    saveDomainFiles(DEFAULTS, tmpDir);
    const loaded = loadDomainFiles(tmpDir);
    expect(loaded).not.toBeNull();
    // Compare key fields
    expect(loaded!.model).toBe(DEFAULTS.model);
    expect(loaded!.locale).toBe(DEFAULTS.locale);
    expect(loaded!.contextWindow).toBe(DEFAULTS.contextWindow);
    expect(loaded!.provider.baseUrl).toBe(DEFAULTS.provider.baseUrl);
    expect(loaded!.security!.enabled).toBe(DEFAULTS.security!.enabled);
    expect(loaded!.browser.headless).toBe(DEFAULTS.browser.headless);
    expect(loaded!.lsp!.enabled).toBe(DEFAULTS.lsp!.enabled);
    expect(loaded!.updater.enabled).toBe(DEFAULTS.updater.enabled);
  });

  it("returns null when no domain files exist", () => {
    const tmpDir = makeTempDir();
    expect(loadDomainFiles(tmpDir)).toBeNull();
  });

  it("hasDomainFiles returns true after save", () => {
    const tmpDir = makeTempDir();
    expect(hasDomainFiles(tmpDir)).toBe(false);
    saveDomainFiles(DEFAULTS, tmpDir);
    expect(hasDomainFiles(tmpDir)).toBe(true);
  });

  it("skips empty domains", () => {
    const tmpDir = makeTempDir();
    const config: AppConfig = {
      ...DEFAULTS,
      mcpServers: {},
      webSearch: undefined,
      errorWebSearch: undefined,
    };
    saveDomainFiles(config, tmpDir);
    // search domain should not have a file (both keys are undefined)
    expect(existsSync(getDomainFilePath(tmpDir, "search"))).toBe(false);
  });
});

describe("domains.ts — RegExp round-trip in domain files", () => {
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
    const d = mkdtempSync(join(tmpdir(), "mma-regexp-"));
    tmpDirs.push(d);
    return d;
  }

  it("preserves RegExp in security.contentScan.dangerousPatterns", () => {
    const tmpDir = makeTempDir();
    const config: AppConfig = {
      ...DEFAULTS,
      security: {
        ...DEFAULTS.security!,
        contentScan: {
          enabled: true,
          dangerousPatterns: [/eval\(/, /new Function\(/, /child_process/],
        },
      },
    };
    saveDomainFiles(config, tmpDir);

    // Verify the file has __regex format
    const secFile = readFileSync(getDomainFilePath(tmpDir, "security"), "utf-8");
    const secData = JSON.parse(secFile);
    const patterns = secData.security.contentScan.dangerousPatterns;
    expect(patterns).toHaveLength(3);
    expect(patterns[0].__regex).toBe(true);
    expect(patterns[0].source).toBe("eval\\(");
    expect(patterns[1].source).toBe("new Function\\(");

    // Load and verify RegExp restored
    const loaded = loadDomainFiles(tmpDir);
    expect(loaded).not.toBeNull();
    const loadedPatterns = (loaded!.security as any).contentScan.dangerousPatterns;
    expect(loadedPatterns).toHaveLength(3);
    expect(loadedPatterns[0]).toBeInstanceOf(RegExp);
    expect(loadedPatterns[0].source).toBe("eval\\(");
    expect(loadedPatterns[1]).toBeInstanceOf(RegExp);
    expect(loadedPatterns[1].source).toBe("new Function\\(");
    expect(loadedPatterns[2]).toBeInstanceOf(RegExp);
    expect(loadedPatterns[2].source).toBe("child_process");
  });
});

describe("loadConfig — domain file integration", () => {
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
    const d = mkdtempSync(join(tmpdir(), "mma-load-"));
    tmpDirs.push(d);
    return d;
  }

  it("first run: returns defaults without creating files", () => {
    const tmpDir = makeTempDir();
    const { config, legacyDetected } = loadConfig({
      configDir: tmpDir,
      projectConfigPath: join(tmpDir, ".mmrc"),
    });
    expect(config.model).toBe(DEFAULTS.model);
    expect(config.locale).toBe(DEFAULTS.locale);
    expect(legacyDetected).toBe(false);
    expect(hasDomainFiles(tmpDir)).toBe(false);
    expect(existsSync(join(tmpDir, "config"))).toBe(false);
    expect(existsSync(join(tmpDir, "config.json"))).toBe(false);
  });

  it("legacy config.json: reads it, sets legacyDetected", () => {
    const tmpDir = makeTempDir();
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({ version: "2.0.0", model: "legacy-model" }),
    );
    const { config, legacyDetected } = loadConfig({
      configDir: tmpDir,
      projectConfigPath: join(tmpDir, ".mmrc"),
    });
    expect(config.model).toBe("legacy-model");
    expect(legacyDetected).toBe(true);
  });

  it("domain files override legacy config.json", () => {
    const tmpDir = makeTempDir();
    // Legacy has model=X
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({ version: "2.0.0", model: "legacy-model" }),
    );
    // Domain has model=Y
    mkdirSync(join(tmpDir, "config"), { recursive: true });
    writeFileSync(
      join(tmpDir, "config", "core.json"),
      JSON.stringify({ model: "domain-model" }),
    );
    const { config, legacyDetected } = loadConfig({
      configDir: tmpDir,
      projectConfigPath: join(tmpDir, ".mmrc"),
    });
    expect(config.model).toBe("domain-model");
    expect(legacyDetected).toBe(false);
  });

  it("heals dangerousPatterns corrupted to [object Object] by the old wire bug", () => {
    const tmpDir = makeTempDir();
    mkdirSync(join(tmpDir, "config"), { recursive: true });
    writeFileSync(
      join(tmpDir, "config", "security.json"),
      JSON.stringify({
        security: {
          contentScan: {
            enabled: true,
            dangerousPatterns: [
              { __regex: true, source: "[object Object]", flags: "" },
              { __regex: true, source: "[object Object]", flags: "" },
            ],
          },
        },
      }),
    );
    const { config } = loadConfig({
      configDir: tmpDir,
      projectConfigPath: join(tmpDir, ".mmrc"),
    });
    const patterns = config.security!.contentScan.dangerousPatterns;
    expect(patterns).toEqual(DEFAULTS.security!.contentScan.dangerousPatterns);
    expect(patterns[0].source).toBe("eval\\(");
  });

  it("keeps valid patterns and only replaces the corrupt ones", () => {
    const tmpDir = makeTempDir();
    mkdirSync(join(tmpDir, "config"), { recursive: true });
    writeFileSync(
      join(tmpDir, "config", "security.json"),
      JSON.stringify({
        security: {
          contentScan: {
            enabled: true,
            dangerousPatterns: [
              { __regex: true, source: "[object Object]", flags: "" },
              { __regex: true, source: "my-custom-pattern", flags: "" },
            ],
          },
        },
      }),
    );
    const { config } = loadConfig({
      configDir: tmpDir,
      projectConfigPath: join(tmpDir, ".mmrc"),
    });
    const patterns = config.security!.contentScan.dangerousPatterns;
    expect(patterns).toHaveLength(2);
    expect(patterns[0].source).toBe("eval\\(");
    expect(patterns[1].source).toBe("my-custom-pattern");
  });

  it("coexistence: config.json + domain files → domain wins", () => {
    const tmpDir = makeTempDir();
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        version: "2.0.0",
        model: "json-model",
        locale: "en",
      }),
    );
    mkdirSync(join(tmpDir, "config"), { recursive: true });
    writeFileSync(
      join(tmpDir, "config", "core.json"),
      JSON.stringify({ model: "domain-model" }),
    );
    const { config } = loadConfig({
      configDir: tmpDir,
      projectConfigPath: join(tmpDir, ".mmrc"),
    });
    // model from domain wins
    expect(config.model).toBe("domain-model");
    // locale from legacy still present (not overridden by domain)
    expect(config.locale).toBe("en");
  });

  it("project .mmrc overrides everything", () => {
    const tmpDir = makeTempDir();
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({ version: "2.0.0", model: "json-model" }),
    );
    mkdirSync(join(tmpDir, "config"), { recursive: true });
    writeFileSync(
      join(tmpDir, "config", "core.json"),
      JSON.stringify({ model: "domain-model" }),
    );
    writeFileSync(join(tmpDir, ".mmrc"), JSON.stringify({ model: "project-model" }));
    const { config } = loadConfig({
      configDir: tmpDir,
      projectConfigPath: join(tmpDir, ".mmrc"),
    });
    expect(config.model).toBe("project-model");
  });

  it("env vars override everything", () => {
    const tmpDir = makeTempDir();
    const prev = process.env.MMA_MODEL;
    process.env.MMA_MODEL = "env-model";
    try {
      const { config } = loadConfig({
        configDir: tmpDir,
        projectConfigPath: join(tmpDir, ".mmrc"),
      });
      expect(config.model).toBe("env-model");
    } finally {
      if (prev) process.env.MMA_MODEL = prev;
      else delete process.env.MMA_MODEL;
    }
  });
});

describe("loadConfig — migration from legacy to domain", () => {
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
    const d = mkdtempSync(join(tmpdir(), "mma-migrate-"));
    tmpDirs.push(d);
    return d;
  }

  it("saveConfig with configDir writes domain files, not config.json", () => {
    const tmpDir = makeTempDir();
    const configPath = join(tmpDir, "config.json");
    saveConfig(DEFAULTS, configPath, tmpDir);
    expect(existsSync(configPath)).toBe(false);
    expect(hasDomainFiles(tmpDir)).toBe(true);
  });

  it("saveConfig without configDir writes legacy config.json", () => {
    const tmpDir = makeTempDir();
    const configPath = join(tmpDir, "config.json");
    saveConfig(DEFAULTS, configPath);
    expect(existsSync(configPath)).toBe(true);
  });

  it("migration: config.json values preserved in domain files", () => {
    const tmpDir = makeTempDir();
    const legacyConfig = {
      version: "2.0.0",
      model: "my-custom-model",
      locale: "ru",
      contextWindow: 65536,
      provider: {
        type: "openai-compat",
        baseUrl: "http://my-server:1234/v1",
        apiKey: "my-secret-key",
      },
      security: {
        enabled: false,
        bash: {
          enabled: false,
          blacklist: ["custom-cmd"],
          whitelist: [],
          blockDangerousFlags: false,
          logCommands: true,
          dangerousFlags: [],
          dangerousOperators: [],
        },
      },
    };
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify(legacyConfig));

    // Load (reads legacy)
    const { config: loaded } = loadConfig({
      configDir: tmpDir,
      projectConfigPath: join(tmpDir, ".mmrc"),
    });
    expect(loaded.model).toBe("my-custom-model");
    expect(loaded.locale).toBe("ru");
    expect(loaded.security!.enabled).toBe(false);

    // Save to domain files
    saveConfig(loaded, join(tmpDir, "config.json"), tmpDir);
    expect(hasDomainFiles(tmpDir)).toBe(true);

    // Reload from domain files only (delete legacy)
    rmSync(join(tmpDir, "config.json"));
    const { config: reloaded, legacyDetected } = loadConfig({
      configDir: tmpDir,
      projectConfigPath: join(tmpDir, ".mmrc"),
    });
    expect(legacyDetected).toBe(false);
    expect(reloaded.model).toBe("my-custom-model");
    expect(reloaded.locale).toBe("ru");
    expect(reloaded.security!.enabled).toBe(false);
    expect(reloaded.security!.bash.blacklist).toContain("custom-cmd");
    expect(reloaded.provider.baseUrl).toBe("http://my-server:1234/v1");
    expect(reloaded.provider.apiKey).toBe("my-secret-key");
  });

  it("migration preserves RegExp in security.contentScan", () => {
    const tmpDir = makeTempDir();
    const legacyConfig = {
      version: "2.0.0",
      security: {
        enabled: true,
        contentScan: {
          enabled: true,
          dangerousPatterns: [
            { __regex: true, source: "eval\\(", flags: "" },
            { __regex: true, source: "require\\(", flags: "" },
          ],
        },
      },
    };
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify(legacyConfig));

    const { config: loaded } = loadConfig({
      configDir: tmpDir,
      projectConfigPath: join(tmpDir, ".mmrc"),
    });

    // RegExp should be restored
    const patterns = loaded.security!.contentScan.dangerousPatterns;
    expect(patterns).toHaveLength(2);
    expect(patterns[0]).toBeInstanceOf(RegExp);
    expect(patterns[0].source).toBe("eval\\(");

    // Save to domain files
    saveConfig(loaded, join(tmpDir, "config.json"), tmpDir);

    // Delete legacy and reload
    rmSync(join(tmpDir, "config.json"));
    const { config: reloaded } = loadConfig({
      configDir: tmpDir,
      projectConfigPath: join(tmpDir, ".mmrc"),
    });

    // RegExp still intact after domain round-trip
    const reloadedPatterns = reloaded.security!.contentScan.dangerousPatterns;
    expect(reloadedPatterns).toHaveLength(2);
    expect(reloadedPatterns[0]).toBeInstanceOf(RegExp);
    expect(reloadedPatterns[0].source).toBe("eval\\(");
    expect(reloadedPatterns[1]).toBeInstanceOf(RegExp);
    expect(reloadedPatterns[1].source).toBe("require\\(");
  });

  it("partial domain files: missing domains fall back to defaults", () => {
    const tmpDir = makeTempDir();
    mkdirSync(join(tmpDir, "config"), { recursive: true });
    // Only create core.json, everything else should come from defaults
    writeFileSync(
      join(tmpDir, "config", "core.json"),
      JSON.stringify({ model: "partial-model" }),
    );
    const { config } = loadConfig({
      configDir: tmpDir,
      projectConfigPath: join(tmpDir, ".mmrc"),
    });
    expect(config.model).toBe("partial-model");
    // These come from defaults (no domain file for them)
    expect(config.locale).toBe(DEFAULTS.locale);
    expect(config.browser.headless).toBe(DEFAULTS.browser.headless);
    expect(config.security!.enabled).toBe(DEFAULTS.security!.enabled);
  });

  it("malformed domain file is skipped gracefully", () => {
    const tmpDir = makeTempDir();
    mkdirSync(join(tmpDir, "config"), { recursive: true });
    writeFileSync(join(tmpDir, "config", "core.json"), "NOT JSON!!!");
    writeFileSync(
      join(tmpDir, "config", "browser.json"),
      JSON.stringify({ browser: { headless: false } }),
    );
    const { config } = loadConfig({
      configDir: tmpDir,
      projectConfigPath: join(tmpDir, ".mmrc"),
    });
    // core.json was malformed, falls back to defaults
    expect(config.model).toBe(DEFAULTS.model);
    // browser.json was valid
    expect(config.browser.headless).toBe(false);
  });

  it("full round-trip: save → load → mutate → save → load", () => {
    const tmpDir = makeTempDir();

    // First save
    saveConfig(DEFAULTS, join(tmpDir, "config.json"), tmpDir);
    expect(hasDomainFiles(tmpDir)).toBe(true);

    // Load
    const { config: loaded } = loadConfig({
      configDir: tmpDir,
      projectConfigPath: join(tmpDir, ".mmrc"),
    });
    expect(loaded.model).toBe(DEFAULTS.model);

    // Mutate
    loaded.model = "changed-model";
    loaded.locale = "ru";

    // Save again
    saveConfig(loaded, join(tmpDir, "config.json"), tmpDir);

    // Reload
    const { config: reloaded } = loadConfig({
      configDir: tmpDir,
      projectConfigPath: join(tmpDir, ".mmrc"),
    });
    expect(reloaded.model).toBe("changed-model");
    expect(reloaded.locale).toBe("ru");
    // Other fields still default
    expect(reloaded.contextWindow).toBe(DEFAULTS.contextWindow);
    expect(reloaded.autoPlan).toBe(DEFAULTS.autoPlan);
  });
});

describe("loadConfig — legacy LSP args normalization with domain files", () => {
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
    const d = mkdtempSync(join(tmpdir(), "mma-lsp-"));
    tmpDirs.push(d);
    return d;
  }

  it("normalizes stale LSP args from domain files", () => {
    const tmpDir = makeTempDir();
    mkdirSync(join(tmpDir, "config"), { recursive: true });
    writeFileSync(
      join(tmpDir, "config", "lsp.json"),
      JSON.stringify({
        lsp: {
          enabled: true,
          servers: {
            typescript: {
              command: "npx",
              args: ["typescript-language-server", "--stdio"],
              timeout: 20000,
              workspaceMarkers: ["package.json", "tsconfig.json"],
            },
          },
        },
      }),
    );
    const { config } = loadConfig({
      configDir: tmpDir,
      projectConfigPath: join(tmpDir, ".mmrc"),
    });
    // Should be normalized to current defaults
    expect(config.lsp!.servers.typescript.args).toContain("--yes");
    expect(config.lsp!.servers.typescript.args).toContain("typescript@5");
    expect(config.lsp!.servers.typescript.timeout).toBe(30000);
  });
});
