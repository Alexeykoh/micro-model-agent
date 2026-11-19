// INV-20 (W3.4): запись одного ключа пишет только его домен — параллельная
// правка другого домена (например, CLI во время открытой вкладки) не теряется.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { DEFAULTS } from "../../src/config/defaults";
import { loadConfig, saveConfig } from "../../src/config/config";
import { setConfigValue } from "../../src/config/registry";
import { persistConfigChange, configVersion, domainForConfigKey } from "../../src/config/persist";
import { getDomainFilePath } from "../../src/config/domains";

describe("persistConfigChange — merge by changed key (INV-20)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true });
      } catch {}
    }
    dirs.length = 0;
  });

  function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), "mma-persist-"));
    dirs.push(d);
    return d;
  }

  it("survives a concurrent CLI edit to another domain (W3.4 acceptance)", () => {
    const dir = tmp();
    const configPath = join(dir, "config.json");

    // Web keeps a bootstrap snapshot and persists it once (all domains).
    const webConfig = structuredClone(DEFAULTS);
    saveConfig(webConfig, configPath, dir);

    // A CLI process edits a DIFFERENT domain (provider) on disk afterwards.
    const cliConfig = loadConfig({ configDir: dir, projectConfigPath: join(dir, ".mmrc") }).config;
    cliConfig.provider.baseUrl = "http://cli-edited:1234/v1";
    saveConfig(cliConfig, configPath, dir);

    // Web now writes `model` (core domain) from its STALE snapshot.
    expect(setConfigValue(webConfig, "model", "web-model").ok).toBe(true);
    persistConfigChange(webConfig, "model", configPath, dir);

    // The CLI provider edit is intact; the web model write landed.
    const reread = loadConfig({ configDir: dir, projectConfigPath: join(dir, ".mmrc") }).config;
    expect(reread.provider.baseUrl).toBe("http://cli-edited:1234/v1");
    expect(reread.model).toBe("web-model");
  });

  it("bumps the config version on each write", () => {
    const dir = tmp();
    const config = structuredClone(DEFAULTS);
    expect(configVersion(config)).toBe(0);
    persistConfigChange(config, "model", join(dir, "config.json"), dir);
    expect(configVersion(config)).toBe(1);
  });

  it("falls back to a full save for an unknown key", () => {
    const dir = tmp();
    const config = structuredClone(DEFAULTS);
    config.provider.baseUrl = "http://x:1/v1";
    persistConfigChange(config, "totally.unknown", join(dir, "config.json"), dir);
    expect(existsSync(getDomainFilePath(dir, "core"))).toBe(true);
    expect(existsSync(getDomainFilePath(dir, "provider"))).toBe(true);
  });

  it("maps registry keys to their config domain", () => {
    expect(domainForConfigKey("model")).toBe("core");
    expect(domainForConfigKey("provider.active")).toBe("provider");
    expect(domainForConfigKey("lsp.enabled")).toBe("lsp");
    expect(domainForConfigKey("nope.not.a.key")).toBeNull();
  });
});
