import { describe, it, expect } from "bun:test";
import { ensureSessionStart } from "../../src/core/agent/session-start";

function hostWithSystem(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const lazyBlock = { content: "lazy", priority: "low", essential: false, estimatedTokens: 1 };
  const deps = {
    promptBlocks: [] as unknown[],
    lazyPromptBlocks: async () => [lazyBlock],
    contextManager: {
      getActiveHistory: () => [{ role: "system", content: "old system" }],
    },
    logger: { warn: () => {}, logSilent: () => {} },
  };
  return {
    calls,
    lazyBlock,
    input: {
      deps,
      systemPromptAdded: true,
      overflowResolved: false,
      buildSystemPrompt: () => {
        throw new Error("must not build on resume path");
      },
      resolvePromptOverflowOnce: async () => {
        calls.push("resolve");
      },
      refreshSystemPrompt: () => {
        calls.push("refresh");
      },
      ...overrides,
    } as never,
  };
}

describe("session start resume path (B11)", () => {
  it("resolves overflow and refreshes the system message on a resumed agent", async () => {
    const { input, calls } = hostWithSystem();
    const result = await ensureSessionStart(input, {} as never);
    expect(calls).toEqual(["resolve", "refresh"]);
    expect(result).toEqual({ systemPromptAdded: true, overflowResolved: true });
  });

  it("stays silent when overflow was already resolved", async () => {
    const { input, calls } = hostWithSystem({ overflowResolved: true });
    const result = await ensureSessionStart(input, {} as never);
    expect(calls).toEqual([]);
    expect(result).toBeNull();
  });

  it("adds lazy blocks once, without duplicating them", async () => {
    const { input, lazyBlock } = hostWithSystem();
    const deps = input.deps as unknown as { promptBlocks: unknown[] };
    deps.promptBlocks.push(lazyBlock);
    const before = deps.promptBlocks.length;
    await ensureSessionStart(input, {} as never);
    expect(deps.promptBlocks.length).toBe(before);
  });

  it("still refreshes when the resolve itself fails (fail-open)", async () => {
    const { input, calls } = hostWithSystem({
      resolvePromptOverflowOnce: async () => {
        calls.push("resolve");
        throw new Error("backend down");
      },
    });
    const result = await ensureSessionStart(input, {} as never);
    expect(calls).toEqual(["resolve", "refresh"]);
    expect(result?.overflowResolved).toBe(true);
  });
});
