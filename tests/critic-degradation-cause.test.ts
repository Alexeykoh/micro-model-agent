import { describe, it, expect, vi } from "vitest";
import { CriticGate } from "../src/core/agent/critic-gate";
import { CRITIC_DEGRADED_PREFIX } from "../src/modules/critic/client";
import { createLoopModules } from "../src/core/agent/loop-setup";
import { createLoopState } from "../src/core/agent/loop-state";
import { CriticClient } from "../src/modules/critic/client";

/**
 * Причина деградации критика должна доезжать до `session.jsonl` (W3, INV-C4).
 *
 * Было: клиент знал причину («call_timeout», «обрезано по maxTokens»), но
 * писал её только в app-лог; гейт видел лишь `null` и клал в `critic_error`
 * строку «no verdict returned». Разбор сессии не мог отличить «критик не
 * ответил» от «ответ обрезался» от «провайдер упал».
 */
describe("critic degradation cause (W3)", () => {
  function gateDeps() {
    const state = createLoopState();
    const events: Array<{ name: string; data: Record<string, unknown> }> = [];
    return {
      state,
      events,
      deps: {
        state,
        iteration: 2,
        logger: { warn: vi.fn(), info: vi.fn(), diagnostic: vi.fn() } as never,
        contextManager: { addMessage: vi.fn() } as never,
        slog: {
          logCritic: (name: string, data: Record<string, unknown> = {}) =>
            events.push({ name, data }),
          logDiagnosticEvent: (name: string, data: Record<string, unknown>) =>
            events.push({ name, data }),
        } as never,
        task: "do it",
        beforeFinish: true,
        toolEvents: [{ tool: "bash", args: { command: "ls" }, ok: true }],
      },
    };
  }

  it("writes the reason reported by the client into critic_error", async () => {
    const d = gateDeps();
    const gate = new CriticGate({
      enabled: true,
      maxCalls: 4,
      maxRepairCycles: 1,
      verify: async () => null,
      buildPack: (x: never) => x,
      degradationReason: () => "call_timeout (15000ms)",
    });
    await gate.evaluate(d.deps);
    const err = d.events.find((e) => e.name === "critic_error");
    expect(err?.data.cause).toBe("call_timeout (15000ms)");
  });

  it("prefers the thrown error over the client reason", async () => {
    const d = gateDeps();
    const gate = new CriticGate({
      enabled: true,
      maxCalls: 4,
      maxRepairCycles: 1,
      verify: async () => {
        throw new Error("boom");
      },
      buildPack: (x: never) => x,
      degradationReason: () => "call_timeout (15000ms)",
    });
    await gate.evaluate(d.deps);
    const err = d.events.find((e) => e.name === "critic_error");
    expect(err?.data.cause).toBe("boom");
  });

  it("the client reports degradations with a machine-readable prefix", async () => {
    const logs: string[] = [];
    const client = new CriticClient({
      provider: {
        model: "m",
        contextWindow: 1000,
        countTokens: () => 0,
        listModels: async () => [],
        // eslint-disable-next-line require-yield
        async *chat() {
          throw new Error("provider down");
        },
      },
      onDiagnostic: (m) => logs.push(m),
    });
    await client.verify({ task: "t", changedFiles: [], commands: [], toolDigest: "" });
    const degraded = logs.find((l) => l.startsWith(CRITIC_DEGRADED_PREFIX));
    expect(degraded).toBeDefined();
    expect(degraded).toContain("provider down");
  });
});

describe("critic gate wiring carries the real cause (W3, integration)", () => {
  it("the gate reports the provider failure, not 'no verdict returned'", async () => {
    // Настоящая связка loop-setup: клиент -> гейт -> session-лог.
    const provider = {
      model: "m",
      contextWindow: 1000,
      countTokens: () => 0,
      listModels: async () => [],
      // eslint-disable-next-line require-yield
      async *chat() {
        throw new Error("provider down");
      },
    };
    const events: Array<{ name: string; data: Record<string, unknown> }> = [];
    const slog = {
      logCritic: (name: string, data: Record<string, unknown> = {}) => events.push({ name, data }),
      logDiagnosticEvent: (name: string, data: Record<string, unknown>) => events.push({ name, data }),
    } as never;
    const deps = {
      config: {
        version: "2.0.0",
        model: "m",
        provider: { type: "openai-compat", baseUrl: "http://localhost:1234/v1" },
        critic: { enabled: true, tools: false, maxCalls: 4, maxRepairCycles: 1, timeoutMs: 5000, maxTokens: 512 },
        contextWindow: 4096,
        maxToolIterations: 5,
        retry: { maxRetries: 1, baseDelay: 10, maxDelay: 20 },
      },
      llmProvider: provider,
      toolExecutor: { execute: vi.fn(), getToolDefinitions: vi.fn(() => []) },
      pluginManager: {},
      contextManager: { getActiveHistory: () => [] },
      hallucinationDetector: {},
      logger: { diagnostic: vi.fn(), warn: vi.fn(), info: vi.fn() },
      baseDir: process.cwd(),
    } as never;
    const host = {
      deps,
      costTracker: undefined,
      getAbortSignal: () => undefined,
      isShutdownRequested: () => false,
      setScope: () => {},
      callerProvenance: () => ({ provider: "p", model: "m" }),
    } as never;

    const modules = createLoopModules(host, slog);
    await modules.criticGate.evaluate({
      state: modules.state,
      iteration: 1,
      logger: deps.logger,
      contextManager: deps.contextManager,
      slog,
      task: "do it",
      beforeFinish: true,
      toolEvents: [{ tool: "bash", args: { command: "ls" }, ok: true }],
    });

    const err = events.find((e) => e.name === "critic_error");
    expect(err).toBeDefined();
    expect(String(err?.data.cause)).toContain("provider down");
    expect(String(err?.data.cause)).not.toBe("no verdict returned");
  });
});
