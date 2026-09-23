import { describe, it, expect, vi } from "vitest";
import { runMeet } from "../../src/modules/onboarding/meet";

function fakeCtx(over: Record<string, unknown> = {}) {
  return {
    config: { provider: { baseUrl: "http://x/v1", apiKey: "k" }, model: "m" },
    baseDir: "/tmp",
    toolCtx: {},
    agent: { pushPromptBlock() {}, removePromptBlock() {} },
    output: { writeLine: vi.fn() },
    runAgent: vi.fn(async () => {}),
    ...over,
  } as any;
}

describe("runMeet", () => {
  it("refuses when preflight fails", async () => {
    const ctx = fakeCtx();
    const ok = await runMeet(ctx, { preflight: async () => ({ ok: false, reason: "unreachable", ms: 3 }) });
    expect(ok).toBe(false);
    expect(ctx.runAgent).not.toHaveBeenCalled();
    expect(ctx.toolCtx.toolAllowlist).toBeUndefined();
  });

  it("enters mode and starts the interview when preflight succeeds", async () => {
    const ctx = fakeCtx();
    const ok = await runMeet(ctx, { preflight: async () => ({ ok: true, reason: "ok", ms: 3 }) });
    expect(ok).toBe(true);
    expect(ctx.runAgent).toHaveBeenCalledOnce();
    expect(ctx.toolCtx.toolAllowlist).toContain("remember");
  });
});
