import { describe, expect, it } from "vitest";
import {
  LspHealth,
  retryDelayMs,
  MAX_CONSECUTIVE_LSP_FAILURES,
} from "../../../src/modules/lsp/health";
import type { LspServerConfig } from "../../../src/modules/lsp/types";
import {
  LSP_CRASH_GIVEUP_MS,
  LSP_CRASH_LIMIT,
  LSP_CRASH_WINDOW_MS,
  LSP_RETRY_BASE_MS,
  LSP_RETRY_MAX_MS,
} from "../../../src/config/timeouts";

/**
 * Сервер после серии падений уходит в паузу восстановления (2 с → 4 с → … → 60 с),
 * а не отключается до конца сессии: один плохой старт (несовместимый Node,
 * недоступный реестр) раньше убивал LSP до перезапуска mma.
 */

const SERVER: LspServerConfig = { command: "npx", args: [] };

function clock() {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("LspHealth: пауза восстановления", () => {
  it("blocks only after the threshold and reports the remaining wait", () => {
    const c = clock();
    const health = new LspHealth(c.now);

    for (let i = 1; i < MAX_CONSECUTIVE_LSP_FAILURES; i++) {
      const outcome = health.recordFailure("ts", SERVER, "boom");
      expect(outcome.blocked).toBe(false);
    }
    const outcome = health.recordFailure("ts", SERVER, "boom");
    expect(outcome.blocked).toBe(true);
    expect(outcome.retryInMs).toBe(LSP_RETRY_BASE_MS);
    expect(health.isDisabled("ts")).toBe(true);
    expect(health.retryInMs("ts")).toBe(LSP_RETRY_BASE_MS);
    expect(health.blocked()).toEqual([{ key: "ts", retryInMs: LSP_RETRY_BASE_MS }]);
  });

  it("becomes available again after the cooldown expires", () => {
    const c = clock();
    const health = new LspHealth(c.now);
    for (let i = 0; i < MAX_CONSECUTIVE_LSP_FAILURES; i++) health.recordFailure("ts", SERVER, "boom");
    expect(health.isDisabled("ts")).toBe(true);

    c.advance(LSP_RETRY_BASE_MS);
    expect(health.isDisabled("ts")).toBe(false);
    expect(health.blocked()).toEqual([]);
  });

  it("grows the cooldown exponentially and caps it", () => {
    expect(retryDelayMs(MAX_CONSECUTIVE_LSP_FAILURES)).toBe(LSP_RETRY_BASE_MS);
    expect(retryDelayMs(MAX_CONSECUTIVE_LSP_FAILURES + 1)).toBe(LSP_RETRY_BASE_MS * 2);
    expect(retryDelayMs(MAX_CONSECUTIVE_LSP_FAILURES + 2)).toBe(LSP_RETRY_BASE_MS * 4);
    expect(retryDelayMs(MAX_CONSECUTIVE_LSP_FAILURES + 10)).toBe(LSP_RETRY_MAX_MS);
  });

  it("resets the counter and the cooldown after a success", () => {
    const c = clock();
    const health = new LspHealth(c.now);
    for (let i = 0; i < MAX_CONSECUTIVE_LSP_FAILURES; i++) health.recordFailure("ts", SERVER, "boom");
    health.reset("ts");
    expect(health.isDisabled("ts")).toBe(false);
    expect(health.counts().get("ts")).toBe(0);
    // Следующее падение снова ниже порога.
    expect(health.recordFailure("ts", SERVER, "boom").blocked).toBe(false);
  });

  it("keeps one server's cooldown away from another", () => {
    const c = clock();
    const health = new LspHealth(c.now);
    for (let i = 0; i < MAX_CONSECUTIVE_LSP_FAILURES; i++) health.recordFailure("ts", SERVER, "boom");
    expect(health.isDisabled("ts")).toBe(true);
    expect(health.isDisabled("css")).toBe(false);
  });

  it("stops retrying after too many crashes in the window (VS Code semantics)", () => {
    const c = clock();
    const health = new LspHealth(c.now);
    let outcome = health.recordFailure("ts", SERVER, "boom");
    // Набираем больше LSP_CRASH_LIMIT крахов внутри окна (первые два вызова
    // только увеличивают счётчик — пауза начинается с третьего).
    for (let i = 0; i <= LSP_CRASH_LIMIT + 1; i++) {
      c.advance(1000);
      outcome = health.recordFailure("ts", SERVER, "boom");
    }
    expect(outcome.blocked).toBe(true);
    expect(outcome.text).toContain("crashed");
    expect(outcome.retryInMs).toBe(LSP_CRASH_GIVEUP_MS);
  });

  it("forgets old crashes outside the window", () => {
    const c = clock();
    const health = new LspHealth(c.now);
    for (let i = 0; i < MAX_CONSECUTIVE_LSP_FAILURES; i++) health.recordFailure("ts", SERVER, "boom");
    // Окно истекло — серия начинается заново, без «give up».
    c.advance(LSP_CRASH_WINDOW_MS + 1);
    const outcome = health.recordFailure("ts", SERVER, "boom");
    expect(outcome.retryInMs).toBeLessThan(LSP_CRASH_GIVEUP_MS);
  });
});
