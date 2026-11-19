// Guard: контекст хука `onBeforeThink` обязан содержать `sessionLog.directive`.
//
// Регресс из стресс-теста (волна 21): плагин `execution` звал
// `ctx.sessionLog?.directive("stuck-warning", …)`, а пролог итерации передавал
// только `sessionLog.plan`. Каждый stuck-варнинг заканчивался
// `TypeError: ctx.sessionLog?.directive is not a function`, и запись о
// застревании не попадала в `session.jsonl`.
import { describe, it, expect, vi } from "vitest";
import { buildThinkCtx } from "../src/core/agent/iteration-prologue";

function makeCtx(slog: {
  logPlan: (...a: unknown[]) => void;
  logDirective: (...a: unknown[]) => void;
}) {
  return buildThinkCtx({
    iteration: 7,
    turnSeq: 3,
    logger: { warn: vi.fn(), diagnostic: vi.fn(), debug: vi.fn(), info: vi.fn() } as any,
    lastUserMessage: "сделай шаг",
    contextManager: { addMessage: vi.fn() } as any,
    slog: slog as any,
  });
}

describe("контекст onBeforeThink", () => {
  it("sessionLog.directive есть и пишет в лог сессии", () => {
    const slog = { logPlan: vi.fn(), logDirective: vi.fn() };
    const ctx = makeCtx(slog) as any;

    expect(typeof ctx.sessionLog.directive).toBe("function");
    expect(() => ctx.sessionLog.directive("stuck-warning", "нет прогресса", 7)).not.toThrow();

    expect(slog.logDirective).toHaveBeenCalledWith("stuck-warning", "нет прогресса", 7);
  });

  it("sessionLog.plan по-прежнему работает", () => {
    const slog = { logPlan: vi.fn(), logDirective: vi.fn() };
    const ctx = makeCtx(slog) as any;

    ctx.sessionLog.plan("plan_created", "3 шага", 7);

    expect(slog.logPlan).toHaveBeenCalledWith("plan_created", "3 шага", 7);
  });

  it("остальные поля хука на месте", () => {
    const ctx = makeCtx({ logPlan: vi.fn(), logDirective: vi.fn() }) as any;

    expect(ctx.iteration).toBe(7);
    expect(ctx.turnSeq).toBe(3);
    expect(ctx.lastUserMessage).toBe("сделай шаг");
    expect(ctx.logger).toBeTruthy();
    expect(ctx.contextManager).toBeTruthy();
  });
});
