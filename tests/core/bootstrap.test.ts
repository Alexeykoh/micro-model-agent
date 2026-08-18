import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "fs";
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
});
