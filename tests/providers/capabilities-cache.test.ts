import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  readCachedCapabilities,
  writeCachedCapabilities,
} from "../../src/modules/providers/capabilities-cache";

const originalDir = process.env.MMA_CONFIG_DIR;
const dirs: string[] = [];

function isolatedDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mma-caps-"));
  dirs.push(dir);
  process.env.MMA_CONFIG_DIR = dir;
  return dir;
}

afterEach(() => {
  if (originalDir === undefined) delete process.env.MMA_CONFIG_DIR;
  else process.env.MMA_CONFIG_DIR = originalDir;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("capabilities-cache", () => {
  it("keeps native levels for the same endpoint+model", () => {
    isolatedDir();
    writeCachedCapabilities("http://host:8080/v1", "qwen3.8-27b-uncensored", {
      reasoningStrategy: "openai-effort",
      reasoningOff: true,
      reasoningLevels: ["low", "medium", "xhigh"],
    });
    expect(readCachedCapabilities("http://host:8080/v1", "qwen3.8-27b-uncensored")).toMatchObject({
      reasoningLevels: ["low", "medium", "xhigh"],
    });
  });

  it("never mixes capabilities of a different model or endpoint", () => {
    isolatedDir();
    writeCachedCapabilities("http://host:8080/v1", "qwen3.8-27b-uncensored", {
      reasoningLevels: ["low", "medium", "xhigh"],
    });
    expect(readCachedCapabilities("http://host:8080/v1", "deepseek-v4-pro-9b")).toBeUndefined();
    expect(readCachedCapabilities("http://other:8080/v1", "qwen3.8-27b-uncensored")).toBeUndefined();
  });

  it("ignores expired entries", () => {
    const dir = isolatedDir();
    writeCachedCapabilities("http://host:8080/v1", "qwen3.8-27b-uncensored", {
      reasoningLevels: ["low"],
    });
    const path = join(dir, "capabilities-cache.json");
    const all = JSON.parse(readFileSync(path, "utf-8"));
    const key = "http://host:8080/v1|qwen3.8-27b-uncensored";
    all[key].ts = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    writeFileSync(path, JSON.stringify(all));
    expect(readCachedCapabilities("http://host:8080/v1", "qwen3.8-27b-uncensored")).toBeUndefined();
  });
});
