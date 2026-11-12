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
      overflowFingerprint: null,
      buildSystemPrompt: () => ({
        prompt: "sys",
        excluded: [],
        excludedBlocks: [],
        blocks: [],
        essentialTokens: 0,
        essentialOverBudget: false,
        fingerprint: "fp-1",
      }),
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

describe("session start resume path (B11/B16/B17)", () => {
  it("resolves overflow and refreshes the system message on a resumed agent", async () => {
    const { input, calls } = hostWithSystem();
    const result = await ensureSessionStart(input, {} as never);
    expect(calls).toEqual(["resolve", "refresh"]);
    expect(result).toEqual({ systemPromptAdded: true, overflowResolved: true, overflowFingerprint: "fp-1" });
  });

  it("stays silent when the fingerprint is unchanged", async () => {
    const { input, calls } = hostWithSystem({ overflowResolved: true, overflowFingerprint: "fp-1" });
    const result = await ensureSessionStart(input, {} as never);
    expect(calls).toEqual([]);
    expect(result).toBeNull();
  });

  it("re-resolves when instructions changed between runs (B16)", async () => {
    const { input, calls } = hostWithSystem({
      overflowResolved: true,
      overflowFingerprint: "fp-1",
      buildSystemPrompt: () => ({
        prompt: "sys",
        excluded: [],
        excludedBlocks: [],
        blocks: [],
        essentialTokens: 0,
        essentialOverBudget: false,
        fingerprint: "fp-2",
      }),
    });
    const result = await ensureSessionStart(input, {} as never);
    expect(calls).toEqual(["resolve", "refresh"]);
    expect(result?.overflowFingerprint).toBe("fp-2");
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
