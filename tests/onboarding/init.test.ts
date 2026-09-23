import { describe, it, expect, vi } from "vitest";
import { runInit } from "../../src/modules/onboarding/init";
import { INIT_TOOLS } from "../../src/modules/onboarding/prompts";

function fakeCtx() {
  return {
    config: { provider: { baseUrl: "http://x/v1", apiKey: "k" }, model: "m" },
    baseDir: "/tmp/ws",
    toolCtx: {},
    agent: {
      pushPromptBlock: vi.fn(),
      removePromptBlock: vi.fn(),
    },
    output: { writeLine: vi.fn() },
    runAgent: vi.fn(async () => {}),
  } as any;
}

describe("runInit", () => {
  it("sets an init allowlist, runs once, then restores state", async () => {
    const ctx = fakeCtx();
    const ok = await runInit(ctx, { preflight: async () => ({ ok: true, reason: "ok", ms: 1 }) });
    expect(ok).toBe(true);
    expect(ctx.runAgent).toHaveBeenCalledOnce();
    expect(ctx.agent.pushPromptBlock).toHaveBeenCalledOnce();
    expect(ctx.agent.removePromptBlock).toHaveBeenCalledOnce();
    expect(ctx.toolCtx.toolAllowlist).toBeUndefined();
    expect(ctx.toolCtx.onboarding).toBeUndefined();
  });

  it("refuses when preflight fails", async () => {
    const ctx = fakeCtx();
    const ok = await runInit(ctx, { preflight: async () => ({ ok: false, reason: "no-model", ms: 1 }) });
    expect(ok).toBe(false);
    expect(ctx.runAgent).not.toHaveBeenCalled();
    expect(ctx.output.writeLine).toHaveBeenCalled();
  });

  it("refuses while another onboarding mode is active", async () => {
    const ctx = fakeCtx();
    ctx.toolCtx.onboarding = { done: false };
    const ok = await runInit(ctx, { preflight: async () => ({ ok: true, reason: "ok", ms: 1 }) });
    expect(ok).toBe(false);
    expect(ctx.runAgent).not.toHaveBeenCalled();
  });

  it("uses the full init allowlist and removes the block on failure", async () => {
    const ctx = fakeCtx();
    ctx.runAgent = vi.fn(async () => { throw new Error("boom"); });
    await expect(
      runInit(ctx, { preflight: async () => ({ ok: true, reason: "ok", ms: 1 }) }),
    ).rejects.toThrow("boom");
    expect(ctx.toolCtx.toolAllowlist).toBeUndefined();
    expect(ctx.agent.removePromptBlock).toHaveBeenCalled();
  });
});
