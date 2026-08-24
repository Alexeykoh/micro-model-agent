import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { bootstrap, buildSystemInfo } from "../../src/core/bootstrap";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "mma-bootstrap-"));
}

describe("bootstrap", () => {
  it("creates agent with valid config", async () => {
    const dir = tempDir();
    try {
      const result = await bootstrap(dir, dir);
      expect(result.agent).toBeDefined();
      expect(result.config).toBeDefined();
      expect(result.logger).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("uses defaults when no config found", async () => {
    const dir = tempDir();
    try {
      const result = await bootstrap(dir, dir);
      expect(result.agent).toBeDefined();
      expect(result.config.model).toBe("qwen/qwen3.5-9b");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("exposes live sessionId/sessionContext that follow a session switch", async () => {
    // Regression (ses_msyghz8w): toolCtx.sessionId was captured once at
    // bootstrap, so after a REPL /new or /resume the new session's audit
    // entries were tagged with the PREVIOUS session id (observed:
    // ses_msyghz8w/audit.jsonl carrying ses_msyg892p_78kqhc). The getters
    // must read the session manager live.
    const dir = tempDir();
    try {
      const { toolCtx, sessionManager } = await bootstrap(dir, dir);
      const first = sessionManager.getActiveMeta()!.id;
      expect(first).toBeTruthy();
      expect(toolCtx.sessionId).toBe(first);

      sessionManager.create();
      const second = sessionManager.getActiveMeta()!.id;
      expect(second).not.toBe(first);
      expect(toolCtx.sessionId).toBe(second);
      expect(toolCtx.sessionContext?.sessionId).toBe(second);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("restores a disk-resident plan in a fresh session (project state)", async () => {
    // A plan in .mma/plans/active.json belongs to the PROJECT, not to a
    // session — bootstrap must restore the tracker so `plan show` works
    // and the REPL checklist renders on plan/todo tool events. Nothing is
    // printed unprompted: rendering is event-driven (repl-plan.test.ts).
    const dir = tempDir();
    try {
      mkdirSync(join(dir, ".mma", "plans"), { recursive: true });
      writeFileSync(
        join(dir, ".mma", "plans", "active.json"),
        JSON.stringify({
          id: "stale-plan",
          title: "Old plan",
          createdAt: new Date().toISOString(),
          steps: [{ id: 1, description: "create src/index.ts", status: "pending" }],
        }),
      );
      const { execModule } = await bootstrap(dir, dir);
      expect(execModule.getActivePlan()?.id).toBe("stale-plan");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("advertises Bun as the runtime for TypeScript scripts", () => {
    const info = buildSystemInfo({ model: "test-model" } as any, "/tmp", "win32 shell=cmd");
    expect(info).toContain("Bun is available");
    expect(info).toContain("bun test");
  });

  it("instructs runtime verification for behavior bugs (ses_mst2r0r5)", () => {
    // The agent fixed a rendering bug without ever running the app or the
    // browser. The prompt must tell it to verify runtime behavior against
    // actual output before marking a plan step done.
    const info = buildSystemInfo(
      { model: "test-model", autoPlan: true } as any,
      "/tmp",
      "win32 shell=cmd",
    );
    expect(info).toContain("reproduce");
    expect(info).toContain("runtime behavior");
    expect(info).toContain("plan update");
  });

  it("lists security restrictions only when security is enabled", () => {
    const sec = {
      enabled: true,
      bash: { enabled: true, blacklist: ["rm", "dd"], whitelist: [], blockDangerousFlags: true },
      paths: { enabled: true, denied: [".git/", ".env"] },
      network: { enabled: true, deniedDomains: ["evil.example.com"], allowedDomains: [] },
    };
    const withSec = buildSystemInfo({ model: "m", security: sec } as any, "/tmp", "win32");
    expect(withSec).toContain("SECURITY RESTRICTIONS");
    expect(withSec).toContain("rm, dd");
    expect(withSec).toContain(".git/, .env");
    expect(withSec).toContain("evil.example.com");
    expect(withSec).toContain("[SECURITY BLOCKED]");

    const noList = { ...sec, bash: { ...sec.bash, blacklist: [] }, paths: { ...sec.paths, denied: [] }, network: { ...sec.network, deniedDomains: [] } };
    const noRules = buildSystemInfo({ model: "m", security: noList } as any, "/tmp", "win32");
    expect(noRules).not.toContain("SECURITY RESTRICTIONS");

    const disabled = buildSystemInfo({ model: "m", security: { ...sec, enabled: false } } as any, "/tmp", "win32");
    expect(disabled).not.toContain("SECURITY RESTRICTIONS");
  });
});
