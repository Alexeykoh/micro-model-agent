import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

/** Windows without developer mode cannot create file symlinks; junctions work. */
function linkDir(target: string, link: string): void {
  try {
    symlinkSync(target, link, "dir");
  } catch {
    symlinkSync(target, link, "junction");
  }
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

  it("blocks symlinks that point into private config paths", () => {
    const cfg = tempDir("mma-cfg-");
    const workspace = tempDir("mma-ws-");
    process.env.MMA_CONFIG_DIR = cfg;

    linkDir(cfg, join(workspace, "cfg-link"));
    expect(sensitivePathReason(join(workspace, "cfg-link", ".encryption-key"), workspace)).toContain(
      "key",
    );
    expect(
      sensitivePathReason(join(workspace, "cfg-link", "sessions", "s1", "session.jsonl"), workspace),
    ).toContain("private");

    expect(
      sensitiveCommandReason(
        `cat ${join(workspace, "cfg-link", "sessions", "s1", "session.jsonl")}`,
        workspace,
      ),
    ).toContain("private");
  });

  it("expands ${MMA_CONFIG_DIR} and unwraps sh -c commands", () => {
    const cfg = tempDir("mma-cfg-");
    const workspace = tempDir("mma-ws-");
    process.env.MMA_CONFIG_DIR = cfg;

    expect(sensitivePathReason("${MMA_CONFIG_DIR}/sessions/s1/session.jsonl", workspace)).toContain(
      "private",
    );
    expect(
      sensitiveCommandReason("sh -c 'cat ${MMA_CONFIG_DIR}/sessions/s1/session.jsonl'", workspace),
    ).toContain("private");
    expect(sensitivePathReason("${MMA_CONFIG_DIR}/config/provider.json", workspace)).toBeUndefined();
  });

  it("allows symlinks that stay inside the workspace", () => {
    const cfg = tempDir("mma-cfg-");
    const workspace = tempDir("mma-ws-");
    process.env.MMA_CONFIG_DIR = cfg;

    writeFileSync(join(workspace, "note.txt"), "ok");
    linkDir(workspace, join(workspace, "self-link"));
    expect(sensitivePathReason(join(workspace, "self-link", "note.txt"), workspace)).toBeUndefined();
  });
});
