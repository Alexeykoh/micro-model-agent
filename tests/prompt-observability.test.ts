import { describe, expect, it } from "vitest";
import { logContextStat } from "../src/core/agent/prompt-info";

describe("prompt observability", () => {
  it("logs system+tool tokens together at session start", () => {
    const captured: Record<string, unknown>[] = [];
    const host = {
      deps: {
        config: { contextWindow: 32768, contextBudget: { systemPrompt: 0.1 } },
        contextManager: {
          getSnapshot: () => ({
            window: 32768,
            budget: { systemPrompt: 3276, responseReserve: 4000, history: 24000 },
            toolTokens: 3000,
            tokens: 5000,
            quality: 99,
            messageCount: 2,
            compactionCount: 0,
            iterationsSinceCompaction: 1,
          }),
          getActiveHistory: () => [{ role: "system", content: "S".repeat(100) }],
        },
      },
    };
    const slog = { logContext: (info: Record<string, unknown>) => captured.push(info) };

    logContextStat(host as never, "start", 1, slog as never, []);

    expect(captured).toHaveLength(1);
    expect(captured[0]!.startupTokens).toBe((captured[0]!.systemTokens as number) + 3000);
  });
});
