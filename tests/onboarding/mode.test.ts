import { describe, it, expect } from "vitest";
import { enterMeetMode, exitMeetMode, isMeetDone } from "../../src/modules/onboarding/mode";
import { MEET_TOOLS, MEET_SYSTEM_PROMPT } from "../../src/modules/onboarding/prompts";
import type { ReplContext } from "../../src/cli/repl-commands";

function fakeCtx() {
  const pushed: any[] = [];
  const ctx = {
    toolCtx: {},
    agent: {
      pushPromptBlock: (b: any) => pushed.push(b),
      removePromptBlock: (b: any) => {
        const i = pushed.indexOf(b);
        if (i >= 0) pushed.splice(i, 1);
      },
    },
  };
  return { ctx: ctx as unknown as ReplContext, pushed };
}

describe("onboarding mode", () => {
  it("enters meet mode: allowlist + prompt block + state", () => {
    const { ctx, pushed } = fakeCtx();
    enterMeetMode(ctx);
    expect(ctx.toolCtx.toolAllowlist).toEqual([...MEET_TOOLS]);
    expect(ctx.toolCtx.onboarding?.done).toBe(false);
    expect(ctx.toolCtx.onboarding?.block?.content).toBe(MEET_SYSTEM_PROMPT);
    expect(pushed).toHaveLength(1);
  });

  it("exits meet mode: clears allowlist, state and block", () => {
    const { ctx, pushed } = fakeCtx();
    enterMeetMode(ctx);
    exitMeetMode(ctx);
    expect(ctx.toolCtx.toolAllowlist).toBeUndefined();
    expect(ctx.toolCtx.onboarding).toBeUndefined();
    expect(pushed).toHaveLength(0);
  });

  it("reports done from the shared state", () => {
    const { ctx } = fakeCtx();
    enterMeetMode(ctx);
    expect(isMeetDone(ctx)).toBe(false);
    ctx.toolCtx.onboarding!.done = true;
    expect(isMeetDone(ctx)).toBe(true);
  });
});
