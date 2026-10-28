import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runMeet } from "../../src/modules/onboarding/meet";
import { MEET_TOOLS } from "../../src/modules/onboarding/prompts";
import { t } from "../../src/i18n/index";
import { pc } from "../../src/ui/colors";

const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function setTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
}

afterEach(() => {
  if (originalIsTTY) Object.defineProperty(process.stdout, "isTTY", originalIsTTY);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
});

function fakeCtx(over: Record<string, unknown> = {}) {
  return {
    config: { provider: { baseUrl: "http://x/v1", apiKey: "k" }, model: "m" },
    baseDir: "/tmp",
    toolCtx: {},
    agent: { pushPromptBlock: vi.fn(), removePromptBlock: vi.fn() },
    output: { writeLine: vi.fn() },
    runAgent: vi.fn(async () => {}),
    ...over,
  } as any;
}

describe("runMeet", () => {
  beforeEach(() => {
    setTTY(true);
  });

  it("refuses when preflight fails", async () => {
    const ctx = fakeCtx();
    const ok = await runMeet(ctx, { preflight: async () => ({ ok: false, reason: "unreachable", ms: 3 }) });
    expect(ok).toBe(false);
    expect(ctx.runAgent).not.toHaveBeenCalled();
    expect(ctx.output.writeLine).toHaveBeenCalledTimes(2);
    expect(ctx.toolCtx.onboarding).toBeUndefined();
    expect(ctx.agent.pushPromptBlock).not.toHaveBeenCalled();
  });

  it("enters mode and starts the interview when preflight succeeds", async () => {
    const ctx = fakeCtx();
    const ok = await runMeet(ctx, { preflight: async () => ({ ok: true, reason: "ok", ms: 3 }) });
    expect(ok).toBe(true);
    expect(ctx.toolCtx.toolAllowlist).toEqual([...MEET_TOOLS]);
    expect(ctx.toolCtx.onboarding?.done).toBe(false);
    expect(ctx.runAgent).toHaveBeenCalledOnce();
    expect(ctx.runAgent).toHaveBeenCalledWith(t("repl.meet_start_prompt"));
  });

  it("does not re-enter when onboarding is already active", async () => {
    const existing = { done: false };
    const ctx = fakeCtx({ toolCtx: { onboarding: existing } });
    const ok = await runMeet(ctx, { preflight: async () => ({ ok: true, reason: "ok", ms: 3 }) });
    expect(ok).toBe(true);
    expect(ctx.output.writeLine).toHaveBeenCalledOnce();
    expect(ctx.output.writeLine).toHaveBeenCalledWith(pc.yellow(t("repl.meet_already_hint")));
    expect(ctx.runAgent).not.toHaveBeenCalled();
    expect(ctx.toolCtx.onboarding).toBe(existing);
    expect(ctx.toolCtx.onboarding?.done).toBe(false);
    expect(ctx.agent.pushPromptBlock).not.toHaveBeenCalled();
  });

  it("returns false and does not run when stdout is not a TTY", async () => {
    setTTY(false);
    const ctx = fakeCtx();
    const ok = await runMeet(ctx, { preflight: async () => ({ ok: true, reason: "ok", ms: 3 }) });
    expect(ok).toBe(false);
    expect(ctx.runAgent).not.toHaveBeenCalled();
    expect(ctx.output.writeLine).toHaveBeenCalledOnce();
    // Причина отказа — в stderr: stdout остаётся человеческим выводом, а скрипт
    // видит ненулевой код (A-16).
    expect(ctx.output.writeLine).toHaveBeenCalledWith(
      pc.yellow(t("onboarding.non_interactive")),
      "stderr",
    );
    expect(ctx.toolCtx.onboarding).toBeUndefined();
    expect(ctx.agent.pushPromptBlock).not.toHaveBeenCalled();
  });
});
