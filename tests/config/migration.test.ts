import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadConfig } from "../../src/config/config";
import { MigrationDetector } from "../../src/migration/detect";
import { convertV1toV2 } from "../../src/migration/convert";

/**
 * Миграция v1 → v2 не должна УДАЛЯТЬ конфиг (аудит §7.1, план
 * `2026-10-12-harness-module-audit-fixes`, W7/Task 7.1).
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mma-migrate-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const legacyV1 = {
  version: "1.2.0",
  apiBase: "https://api.example.com/v1",
  apiKey: "sk-real",
  model: "gpt-x",
  contextWindow: 32768,
  temperature: 0.2,
  unknownKey: "keep-me",
};

describe("миграция конфига v1 → v2", () => {
  it("converts a v1 config instead of deleting it", () => {
    const cfgPath = join(dir, "config.json");
    writeFileSync(cfgPath, JSON.stringify(legacyV1), "utf-8");

    const cfg = loadConfig({ configDir: dir });

    // Ключ провайдера переехал в запись.
    const provider = cfg.config.provider;
    expect(provider.apiKey).toBe("sk-real");
    expect(provider.entries?.[0]?.baseUrl).toBe("https://api.example.com/v1");
    // Исходный файл на месте, рядом — сконвертированный.
    expect(existsSync(cfgPath)).toBe(true);
    expect(existsSync(`${cfgPath}.migrated`)).toBe(true);
    // Неизвестные ключи не потеряны — они в сконвертированной копии.
    const migrated = JSON.parse(readFileSync(`${cfgPath}.migrated`, "utf-8"));
    expect(migrated.unknownKey).toBe("keep-me");
  });

  it("does not treat a partially-trimmed v2 config as v1", () => {
    const cfgPath = join(dir, "config.json");
    writeFileSync(cfgPath, JSON.stringify({ provider: {}, contextWindow: 32768 }), "utf-8");
    expect(new MigrationDetector(dir).needsMigration()).toBe(false);
  });

  it("treats a flat provider without entries as v1", () => {
    const cfgPath = join(dir, "config.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({ provider: { type: "openai-compat", baseUrl: "https://x/v1" } }),
      "utf-8",
    );
    expect(new MigrationDetector(dir).needsMigration()).toBe(true);
  });

  it("a v2 config with entries is not a migration candidate", () => {
    const cfgPath = join(dir, "config.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({ provider: { entries: [{ type: "openai-compat", baseUrl: "https://x/v1" }] } }),
      "utf-8",
    );
    expect(new MigrationDetector(dir).needsMigration()).toBe(false);
  });

  it("conversion keeps provider fields and marks the schema", () => {
    const converted = convertV1toV2(legacyV1) as unknown as Record<string, unknown>;
    expect(converted.__schema).toBe(2);
    expect(converted.apiBase).toBeUndefined();
    const provider = converted.provider as Record<string, unknown>;
    expect(provider.active).toBe("openai-compat");
    expect((provider.entries as Array<Record<string, unknown>>)[0]?.apiKey).toBe("sk-real");
  });

  it("a broken config is left alone (no migration, no deletion)", () => {
    const cfgPath = join(dir, "config.json");
    writeFileSync(cfgPath, "{not json", "utf-8");
    expect(new MigrationDetector(dir).needsMigration()).toBe(false);
    loadConfig({ configDir: dir });
    expect(readFileSync(cfgPath, "utf-8")).toBe("{not json");
  });
});
