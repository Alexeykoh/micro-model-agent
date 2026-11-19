import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import {
  extractPushRemote,
  normalizeGitRemoteUrl,
  resolvePushUrl,
  unpushedDiff,
} from "../../src/tools/git-push-egress";
import { gitTool } from "../../src/tools/git";
import type { ToolContext } from "../../src/tools/types";
import type { AppConfig } from "../../src/config/types";

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, env: process.env });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr?.toString()}`);
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "mma-gitpush-"));
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "T");
  writeFileSync(join(dir, "a.txt"), "hello\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "first");
  return dir;
}

function ctx(baseDir: string, network: AppConfig["security"] extends infer S ? S extends { network: infer N } ? N : never : never): ToolContext {
  return {
    baseDir,
    logger: undefined as never,
    config: { security: { network } } as AppConfig,
  } as unknown as ToolContext;
}

const PUBLIC_NET = {
  enabled: true,
  deniedDomains: [],
  allowedDomains: [],
  requestTimeout: 10000,
  maxResponseSize: 1024,
  allowPrivateOutbound: false,
} as never;

describe("git push egress (оплата git-push-egress-ungated)", () => {
  it("extractPushRemote: имя, URL, опции", () => {
    expect(extractPushRemote(["push", "origin"])).toBe("origin");
    expect(extractPushRemote(["push", "--force-with-lease", "origin", "main"])).toBe("origin");
    expect(extractPushRemote(["push"])).toBeUndefined();
    expect(extractPushRemote(["push", "https://github.com/x/y.git"])).toBe("https://github.com/x/y.git");
  });

  it("normalizeGitRemoteUrl: scp и ssh формы", () => {
    expect(normalizeGitRemoteUrl("git@github.com:x/y.git")).toBe("https://github.com/");
    expect(normalizeGitRemoteUrl("ssh://git@github.com/x/y.git")).toBe("https://git@github.com/x/y.git");
  });

  it("resolvePushUrl: имя через remote get-url", async () => {
    const dir = makeRepo();
    git(dir, "remote", "add", "origin", "https://github.com/x/y.git");
    expect(await resolvePushUrl(dir, "origin")).toBe("https://github.com/x/y.git");
    expect(await resolvePushUrl(dir, "missing")).toBeUndefined();
  });

  it("unpushedDiff: пусто когда всё запушено", async () => {
    const dir = makeRepo();
    // Нет @{push}/origin/HEAD — диапазон пустой, скан нечего.
    expect(await unpushedDiff(dir)).toBe("");
  });

  it("push на приватный host блокируется до запуска", async () => {
    const dir = makeRepo();
    git(dir, "remote", "add", "origin", "https://192.168.1.50/x/y.git");
    const r = await gitTool.handler(ctx(dir, PUBLIC_NET), { subcommand: "push", args: ["origin"] });
    expect(r.success).toBe(false);
    expect(String(r.output)).toContain("outbound policy");
  });

  it("push с секретом в незапушенном коммите блокируется", async () => {
    const dir = makeRepo();
    // Имитация origin/HEAD: создаём bare-remote и ветку origin для @{push}
    const bare = mkdtempSync(join(tmpdir(), "mma-gitpush-bare-"));
    git(bare, "init", "--bare");
    git(dir, "remote", "add", "origin", bare);
    git(dir, "fetch", "origin");
    writeFileSync(join(dir, "b.txt"), 'api_key = "sk-1234567890abcdef"\n');
    git(dir, "add", ".");
    git(dir, "commit", "-m", "secret");
    // origin/HEAD не задан — unpushedDiff пустой; задаём @{push} через upstream
    git(dir, "update-ref", "refs/remotes/origin/main", "HEAD~1");
    git(dir, "branch", "-u", "origin/main", "main");
    const diff = await unpushedDiff(dir);
    const { detectSecrets } = await import("../../src/modules/security/data-policy/detectors/secrets");
    expect(detectSecrets(diff).length).toBeGreaterThan(0);
    const r = await gitTool.handler(ctx(dir, PUBLIC_NET), { subcommand: "push", args: ["origin", "main"] });
    // Путь к bare-remote — локальный, outbound его не блокирует (file scheme → не http),
    // но секрет обязан заблокировать до запуска.
    expect(r.success).toBe(false);
    expect(String(r.output)).toMatch(/secret|outbound/);
  });

  it("push без remote блокируется", async () => {
    const dir = makeRepo();
    const r = await gitTool.handler(ctx(dir, PUBLIC_NET), { subcommand: "push", args: [] });
    expect(r.success).toBe(false);
    expect(String(r.output)).toContain("no remote");
  });
});
