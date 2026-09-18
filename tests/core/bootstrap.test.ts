import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { bootstrap, buildSystemInfo } from "../../src/core/bootstrap";
import { Logger } from "../../src/logger/app-logger";
import { defaultOutputBus, type OutputEvent } from "../../src/output";
import { resetProbeCache } from "../../src/modules/reasoning/probe";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "mma-bootstrap-"));
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
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

  it("exposes a LIVE config that follows reconfigure (B1)", async () => {
    // toolCtx.config was captured once at bootstrap; Agent.reconfigure()
    // replaced deps.config but not the executor context, so security
    // validators and tools kept enforcing the OLD settings after a /model
    // use or wizard. The getter must read the shared ref.
    const dir = tempDir();
    try {
      const { toolCtx, agent, config } = await bootstrap(dir, dir);
      expect(toolCtx.config).toBe(config);

      const swapped = { ...config, model: "test/swapped-model" };
      await agent.reconfigure(swapped);
      expect(toolCtx.config).toBe(swapped);
      expect(toolCtx.config.model).toBe("test/swapped-model");
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

  it("writes background probe diagnostics to file only, never to the console", async () => {
    // Both background probes (context + reasoning) used to call logger.info
    // directly, which raced the first-run wizard and interleaved with the
    // REPL prompt. They must go through logSilent (app.jsonl only): the REPL
    // renders the context probe itself via OutputChannel, and the reasoning
    // probe only drives agent behavior. This guards against a regression to
    // logger.warn/info/debug OR a direct console.* / bus.emit call.
    const dir = tempDir();
    const originalFetch = global.fetch;
    const recorded: { method: string; msg: string }[] = [];
    const consoleCalls: { method: string; text: string }[] = [];
    const busEvents: OutputEvent[] = [];

    const loggerMethods = ["logSilent", "warn", "info", "debug"] as const;
    const loggerOriginals: Record<string, unknown> = {};
    for (const method of loggerMethods) {
      loggerOriginals[method] = (Logger.prototype as any)[method];
      (Logger.prototype as any)[method] = function (this: unknown, ...args: unknown[]) {
        const msg = method === "logSilent" ? String(args[1]) : String(args[0]);
        recorded.push({ method, msg });
        return (loggerOriginals[method] as any).apply(this, args);
      };
    }

    const consoleMethods = ["log", "warn", "info", "error"] as const;
    const consoleOriginals: Record<string, unknown> = {};
    for (const method of consoleMethods) {
      consoleOriginals[method] = (console as any)[method];
      (console as any)[method] = function (this: unknown, ...args: unknown[]) {
        consoleCalls.push({
          method,
          text: args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "),
        });
        return (consoleOriginals[method] as any).apply(this, args);
      };
    }

    const unsubscribe = defaultOutputBus.subscribe((ev) => busEvents.push(ev));

    // fetch mock: /api/v1/models answers the context probe; chat/completions
    // answers the (background) reasoning probe with a trivial SSE stream that
    // carries text but no reasoning — deterministic, so no retries/idle waits.
    const encoder = new TextEncoder();
    global.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/v1/models")) {
        return {
          ok: true,
          json: async () => ({
            models: [
              {
                key: "qwen/qwen3.5-9b",
                max_context_length: 131072,
                loaded_instances: [{ config: { context_length: 65536 } }],
              },
            ],
          }),
        };
      }
      const sse = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return {
        ok: true,
        status: 200,
        headers: { get: () => "text/event-stream" },
        body: sse,
        text: async () => "",
        json: async () => ({}),
      };
    }) as unknown as typeof global.fetch;

    // Sandbox the probe disk cache so the test never touches ~/.mma.
    const originalCachePath = process.env.MMA_REASONING_CACHE;
    process.env.MMA_REASONING_CACHE = join(dir, "reasoning-cache.json");
    try {
      resetProbeCache();
      const { contextProbe } = await bootstrap(dir, dir);

      const probe = await contextProbe;
      expect(probe).toEqual({ model: "qwen/qwen3.5-9b", actual: 65536 });

      // The reasoning probe is fire-and-forget (not exposed on the result), so
      // wait until it has logged before asserting and before restoring fetch.
      await waitFor(() => recorded.some((c) => c.msg.includes("Reasoning probe")));

      const contextCalls = recorded.filter((c) => c.msg.includes("Context probe"));
      expect(contextCalls.length).toBeGreaterThan(0);
      expect(contextCalls.every((c) => c.method === "logSilent")).toBe(true);

      const reasoningCalls = recorded.filter((c) => c.msg.includes("Reasoning probe"));
      expect(reasoningCalls.length).toBeGreaterThan(0);
      expect(reasoningCalls.every((c) => c.method === "logSilent")).toBe(true);

      // Neither probe line may reach the console or the output bus directly.
      const needles = ["Context probe", "Reasoning probe"];
      expect(consoleCalls.filter((c) => needles.some((n) => c.text.includes(n)))).toEqual([]);
      expect(busEvents.filter((ev) => needles.some((n) => ev.text.includes(n)))).toEqual([]);
    } finally {
      unsubscribe();
      for (const method of loggerMethods) {
        (Logger.prototype as any)[method] = loggerOriginals[method];
      }
      for (const method of consoleMethods) {
        (console as any)[method] = consoleOriginals[method];
      }
      global.fetch = originalFetch;
      resetProbeCache();
      if (originalCachePath === undefined) delete process.env.MMA_REASONING_CACHE;
      else process.env.MMA_REASONING_CACHE = originalCachePath;
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
