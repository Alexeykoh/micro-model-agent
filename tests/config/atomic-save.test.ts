import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { saveDomainFiles, loadDomainFiles } from "../../src/config/domains";
import { DEFAULTS } from "../../src/config/defaults";
import type { AppConfig } from "../../src/config/types";

/**
 * Доменные файлы конфига: атомарная запись, слияние без потери чужих
 * изменений, шифрование секретов (аудит §7.4/§7.5, план
 * `2026-10-12-harness-module-audit-fixes`, W7/Task 7.2).
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mma-atomic-cfg-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function config(): AppConfig {
  const cfg = structuredClone(DEFAULTS) as AppConfig;
  cfg.provider = {
    ...cfg.provider,
    type: "openai-compat",
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-secret-value-123456",
  };
  return cfg;
}

describe("доменные файлы конфига", () => {
  it("writes a domain atomically (no .tmp left, file readable)", () => {
    saveDomainFiles(config(), dir);
    const providerFile = join(dir, "config", "provider.json");
    expect(existsSync(providerFile)).toBe(true);
    expect(existsSync(`${providerFile}.tmp`)).toBe(false);
    expect(readFileSync(providerFile, "utf-8").length).toBeGreaterThan(0);
  });

  it("does not revert a concurrent external change", () => {
    // Базовый конфиг: одна запись провайдера.
    saveDomainFiles(config(), dir);
    const providerFile = join(dir, "config", "provider.json");
    const before = JSON.parse(readFileSync(providerFile, "utf-8")) as Record<string, unknown>;

    // Другой процесс добавил вторую запись.
    const provider = before.provider as Record<string, unknown>;
    const entries = provider.entries as Array<Record<string, unknown>> | undefined;
    const foreign = {
      type: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
    };
    before.provider = {
      ...provider,
      entries: entries ? [...entries, foreign] : [foreign],
    };
    writeFileSync(providerFile, JSON.stringify(before, null, 2), "utf-8");

    // Мы меняем другой домен и сохраняем конфиг целиком.
    const cfg = config();
    cfg.model = "my-model";
    saveDomainFiles(cfg, dir);

    const after = JSON.parse(readFileSync(providerFile, "utf-8")) as Record<string, unknown>;
    const afterProvider = after.provider as Record<string, unknown>;
    const afterEntries = afterProvider.entries as Array<Record<string, unknown>>;
    expect(afterEntries.some((e) => e.baseUrl === "https://openrouter.ai/api/v1")).toBe(true);
  });

  it("encrypts sensitive fields in the domain file", () => {
    saveDomainFiles(config(), dir);
    const raw = readFileSync(join(dir, "config", "provider.json"), "utf-8");
    expect(raw).not.toContain("sk-secret-value-123456");
  });

  it("a corrupt domain file is quarantined, not silently ignored", () => {
    const providerFile = join(dir, "config", "provider.json");
    rmSync(join(dir, "config"), { recursive: true, force: true });
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(providerFile, "{ broken json", "utf-8");
    const loaded = loadDomainFiles(dir);
    expect(loaded).toBeNull();
    const quarantined = readdirSync(join(dir, "config")).filter((f) => f.includes(".corrupt-"));
    expect(quarantined.length).toBe(1);
  });
});
