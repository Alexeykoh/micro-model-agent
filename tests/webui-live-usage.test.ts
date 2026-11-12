import { describe, it, expect, vi, afterEach } from "vitest";
import type { ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeRunAgent } from "../src/modules/webui/session/run-agent";
import { createWebUiState } from "../src/modules/webui/state";
import { saveSessionUsage } from "../src/modules/webui/session/session-usage";
import type { Forwarder } from "../src/modules/webui/session/forward";
import type { Agent } from "../src/core/agent";
import type { ContextBreakdown } from "../src/core/types";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function breakdown(used: number, window = 32768): ContextBreakdown {
  return {
    system: 3000,
    tools: 2000,
    history: used - 5000,
    used,
    systemBudget: 4096,
    historyBudget: 20643,
    reserve: 3932,
    free: Math.max(0, window - used - 3932),
    window,
  };
}

function noopForwarder(): Forwarder {
  const noop = (): void => {};
  return {
    onText: noop,
    onMeta: noop,
    onReasoning: noop,
    onPhase: noop,
    onToolStart: noop,
    onToolEnd: noop,
    onPlan: noop,
    onTurnEnd: noop,
    flushNow: noop,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("makeRunAgent live context usage", () => {
  it("broadcasts live `usage` while the turn runs and stops on completion", async () => {
    vi.useFakeTimers();
    const state = createWebUiState();
    const events: string[] = [];
    state.clients.add({
      write: (chunk: string) => {
        events.push(chunk);
        return true;
      },
      end: () => {},
    } as unknown as ServerResponse);

    let used = 8000;
    const contextManager = {
      getSnapshot: () => ({
        tokens: used,
        budget: { history: 20643 },
        quality: 92,
        compactionCount: 0,
        breakdown: breakdown(used),
      }),
    };

    const run = deferred<unknown>();
    const agent = { run: () => run.promise } as unknown as Agent;

    const runner = makeRunAgent({
      agent,
      state,
      forwarder: noopForwarder(),
      ownerSessionId: "S",
      contextManager,
    });
    const done = runner.run("hello");

    // First snapshot fires immediately at turn start.
    expect(state.sessionUsage.S?.contextUsed).toBe(8000);
    expect(state.sessionUsage.S?.contextLimit).toBe(20643);

    // Context grows mid-turn; the timer pushes a fresh live snapshot.
    used = 12000;
    vi.advanceTimersByTime(800);
    expect(state.sessionUsage.S?.contextUsed).toBe(12000);
    expect(events.join("")).toContain("event: usage");
    expect(events.join("")).toContain('"usageSessionId":"S"');

    run.resolve({
      success: true,
      text: "",
      iterationCount: 1,
      contextUsed: 13000,
      contextLimit: 20643,
    });
    await done;

    // Timer stopped: later ticks no longer update usage.
    used = 20000;
    vi.advanceTimersByTime(2400);
    expect(state.sessionUsage.S?.contextUsed).toBe(13000);
  });

  it("keeps the session's accumulated totals when the live tick seeds first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "web-live-usage-"));
    try {
      saveSessionUsage(dir, {
        promptTokensTotal: 25729,
        completionTokensTotal: 3586,
        cachedTokensTotal: 14473,
      });
      const state = createWebUiState();
      state.sessionManager = {
        getActive: () => "S",
        getSessionDirectory: () => dir,
      } as never;
      // Глобальный last-turn ЧУЖОЙ сессии: не должен стать базой этой.
      state.usage = { promptTokensTotal: 999999, completionTokensTotal: 999999 };

      const contextManager = {
        getSnapshot: () => ({
          tokens: 8000,
          budget: { history: 20643 },
          quality: 90,
          compactionCount: 0,
          breakdown: breakdown(8000),
        }),
      };
      const run = deferred<unknown>();
      const agent = { run: () => run.promise } as unknown as Agent;
      const runner = makeRunAgent({
        agent,
        state,
        forwarder: noopForwarder(),
        ownerSessionId: "S",
        contextManager,
      });
      const done = runner.run("hello");

      // Первый тик идёт ДО конца хода: база — снимок этой сессии с диска,
      // а не глобальный last-turn соседа.
      expect(state.sessionUsage.S?.promptTokensTotal).toBe(25729);

      run.resolve({
        success: true,
        text: "",
        iterationCount: 1,
        contextUsed: 9000,
        contextLimit: 20643,
        promptTokens: 500,
        completionTokens: 120,
        cache: { cachedTokens: 400, uncachedTokens: 100, cacheWriteTokens: 0, source: "api" },
      });
      await done;

      // Ход наращивает базу журнала, а не начинает с нуля.
      expect(state.sessionUsage.S).toMatchObject({
        promptTokensTotal: 26229,
        completionTokensTotal: 3706,
        cachedTokensTotal: 14873,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
