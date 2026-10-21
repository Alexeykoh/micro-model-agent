import { describe, it, expect } from "vitest";
import {
  RunPool,
  RUNNER_IDLE_MS,
  RUNNER_LRU_MAX,
} from "../src/modules/webui/session/session-pool";
import type { SessionRunner } from "../src/core/bootstrap/session-runner";

/**
 * Пул сессий: простаивающие раннеры вытесняются, лишние — по LRU, занятые
 * не трогаются (аудит §6.11/§6.12, план
 * `2026-10-12-harness-module-audit-fixes`, W6/Task 6.5).
 */

function fakeRunner(): SessionRunner {
  return {
    sessionId: "s",
    dispose: () => {},
    agent: { run: () => new Promise(() => {}), shutdown: () => {} },
    contextManager: { addPendingImage: () => {} },
    execModule: { getActivePlan: () => null },
  } as unknown as SessionRunner;
}

describe("пул сессий: LRU и idle-вытеснение", () => {
  it("evicts an idle runner that has had no turns for RUNNER_IDLE_MS", () => {
    const disposed: string[] = [];
    const pool = new RunPool((id) => {
      const runner = fakeRunner();
      (runner as unknown as { dispose: () => void }).dispose = () => disposed.push(id);
      return runner;
    });
    pool.getOrCreateRunner("s1");
    expect(pool.runnerIds()).toEqual(["s1"]);

    pool.sweep(Date.now() + RUNNER_IDLE_MS + 1000);

    expect(pool.runnerIds()).toEqual([]);
    expect(disposed).toEqual(["s1"]);
    pool.clear();
  });

  it("does not evict a busy runner", () => {
    const pool = new RunPool(() => fakeRunner());
    pool.getOrCreateRunner("s1");
    pool.reserve("s1");

    pool.sweep(Date.now() + RUNNER_IDLE_MS + 1000);

    expect(pool.runnerIds()).toEqual(["s1"]);
    pool.clear();
  });

  it("keeps at most RUNNER_LRU_MAX runners, evicting the least recently used", () => {
    const pool = new RunPool(() => fakeRunner());
    for (let i = 0; i < RUNNER_LRU_MAX + 2; i++) {
      pool.getOrCreateRunner(`s${i}`);
    }
    expect(pool.runnerIds().length).toBe(RUNNER_LRU_MAX + 2);

    pool.sweep();

    expect(pool.runnerIds().length).toBe(RUNNER_LRU_MAX);
    // Самый старый вытеснен.
    expect(pool.runnerIds()).not.toContain("s0");
    pool.clear();
  });

  it("read-only checks do not create slots", () => {
    const pool = new RunPool(() => fakeRunner());
    expect(pool.isBusy("never-seen")).toBe(false);
    pool.forceRelease("never-seen");
    expect(pool.queuedCounts()).toEqual({});
    pool.clear();
  });
});
