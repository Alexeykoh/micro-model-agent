import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectExplicitKeys, loadConfig } from "../../src/config/config";
import { MMA_ENV } from "../../src/config/env";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "mma-explicit-"));
}

function dirWithDomain(raw: string): string {
  const dir = tempDir();
  const configDir = join(dir, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "core.json"), raw, "utf-8");
  return dir;
}

function dirWithLegacy(raw: string): string {
  const dir = tempDir();
  writeFileSync(join(dir, "config.json"), raw, "utf-8");
  return dir;
}

const originalModel = process.env[MMA_ENV.MODEL];
afterEach(() => {
  if (originalModel === undefined) delete process.env[MMA_ENV.MODEL];
  else process.env[MMA_ENV.MODEL] = originalModel;
});

describe("explicitKeys", () => {
  it("отмечает ключ из доменного файла, даже если он равен дефолту", () => {
    const dir = dirWithDomain('{"indexer":{"mapTokenBudget":1500}}');
    const result = loadConfig({ configDir: dir, projectConfigPath: join(dir, ".mmrc") });
    expect(result.config.indexer?.mapTokenBudget).toBe(1500);
    expect(result.explicitKeys.has("indexer.mapTokenBudget")).toBe(true);
    expect(result.explicitKeys.has("contextWindow")).toBe(false);
  });

  it("отмечает ключ из legacy config.json", () => {
    const dir = dirWithLegacy('{"version":"2.0.0","indexer":{"mapTokenBudget":1500}}');
    const result = loadConfig({ configDir: dir, projectConfigPath: join(dir, ".mmrc") });
    expect(result.legacyDetected).toBe(true);
    expect(result.explicitKeys.has("indexer.mapTokenBudget")).toBe(true);
    expect(result.explicitKeys.has("version")).toBe(true);
  });

  it("отмечает ключи из сконвертированного v1-конфига", () => {
    const dir = dirWithLegacy(
      '{"version":"1.2.0","apiBase":"https://api.example.com/v1","apiKey":"sk-real","contextWindow":65536}',
    );
    const result = loadConfig({ configDir: dir, projectConfigPath: join(dir, ".mmrc") });
    expect(result.config.contextWindow).toBe(65536);
    expect(result.explicitKeys.has("contextWindow")).toBe(true);
    expect(result.explicitKeys.has("provider.entries")).toBe(true);
  });

  it("отмечает ключ из проектного .mmrc", () => {
    const dir = tempDir();
    const projectConfigPath = join(dir, ".mmrc");
    writeFileSync(projectConfigPath, '{"indexer":{"mapTokenBudget":1700}}', "utf-8");
    const result = loadConfig({ configDir: dir, projectConfigPath });
    expect(result.config.indexer?.mapTokenBudget).toBe(1700);
    expect(result.explicitKeys.has("indexer.mapTokenBudget")).toBe(true);
  });

  it("отмечает ключ из env-оверрайда", () => {
    const dir = tempDir();
    process.env[MMA_ENV.MODEL] = "env-model";
    const result = loadConfig({ configDir: dir, projectConfigPath: join(dir, ".mmrc") });
    expect(result.config.model).toBe("env-model");
    expect(result.explicitKeys.has("model")).toBe(true);
  });

  it("считает RegExp/Date листьями, а не объектами для рекурсии", () => {
    const keys = collectExplicitKeys({
      security: { contentScan: { dangerousPatterns: /secret/ } },
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    expect(keys.has("security.contentScan.dangerousPatterns")).toBe(true);
    expect(keys.has("createdAt")).toBe(true);
  });
});
