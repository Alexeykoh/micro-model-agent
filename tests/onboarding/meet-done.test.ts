import { describe, it, expect } from "vitest";
import { meetDoneTool } from "../../src/tools/meet-done";
import type { ToolContext } from "../../src/tools/types";

describe("meet_done", () => {
  it("flips ctx.onboarding.done", async () => {
    const ctx = { onboarding: { done: false } } as unknown as ToolContext;
    const res = await meetDoneTool.handler(ctx, {});
    expect(res.success).toBe(true);
    expect(ctx.onboarding!.done).toBe(true);
  });

  it("does not throw and succeeds when ctx.onboarding is undefined", async () => {
    const ctx = {} as ToolContext;
    const res = await meetDoneTool.handler(ctx, {});
    expect(res.success).toBe(true);
  });
});
