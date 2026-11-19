import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  sensitiveCommandReason,
  sensitivePathReason,
} from "../../src/modules/security/sensitive-paths";

const dirs: string[] = [];
const originalConfigDir = process.env.MMA_CONFIG_DIR;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.MMA_CONFIG_DIR;
  else process.env.MMA_CONFIG_DIR = originalConfigDir;
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("sensitive paths: config secrets and agent source", () => {
  it("blocks encryption keys and private config directories", () => {
    const cfg = tempDir("mma-cfg-");
    const workspace = tempDir("mma-ws-");
    process.env.MMA_CONFIG_DIR = cfg;

    expect(sensitivePathReason(join(cfg, ".encryption-key"), workspace)).toContain("key");
    expect(sensitivePathReason(join(cfg, ".session-encryption-key"), workspace)).toContain("key");
    expect(sensitivePathReason(join(cfg, "sessions", "s1", "session.jsonl"), workspace)).toContain(
      "private",
    );
    expect(sensitivePathReason(join(cfg, "logs", "app.jsonl"), workspace)).toContain("private");
    expect(sensitivePathReason(join(cfg, "memory", "facts.md"), workspace)).toContain("private");
  });

  it("allows provider/core config files", () => {
    const cfg = tempDir("mma-cfg-");
    const workspace = tempDir("mma-ws-");
    process.env.MMA_CONFIG_DIR = cfg;
    expect(sensitivePathReason(join(cfg, "config", "provider.json"), workspace)).toBeUndefined();
    expect(sensitivePathReason(join(cfg, "config", "core.json"), workspace)).toBeUndefined();
  });

  it("blocks the agent source tree outside its own workspace", () => {
    const cfg = tempDir("mma-cfg-");
    const workspace = tempDir("mma-ws-");
    process.env.MMA_CONFIG_DIR = cfg;
    const appFile = resolve("/app/src/config/env.ts");
    expect(sensitivePathReason(appFile, workspace)).toContain("source");
    expect(sensitivePathReason("/app/src/config/env.ts", "/app")).toBeUndefined();
  });

  it("catches keys, sessions and /app in shell commands", () => {
    const cfg = tempDir("mma-cfg-");
    const workspace = tempDir("mma-ws-");
    process.env.MMA_CONFIG_DIR = cfg;

    expect(sensitiveCommandReason(`cat ${join(cfg, ".encryption-key")}`, workspace)).toContain(
      "key",
    );
    expect(
      sensitiveCommandReason(`cat ${join(cfg, "sessions", "s1", "session.jsonl")}`, workspace),
    ).toContain("private");
    expect(sensitiveCommandReason(`cat ${join(cfg, "config", "provider.json")}`, workspace)).toBeUndefined();
    expect(sensitiveCommandReason(`cat ${resolve("/app/src/config/env.ts")}`, workspace)).toContain(
      "source",
    );
  });
});
