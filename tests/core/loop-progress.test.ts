// Метрика прогресса хода: кумулятивные счётчики не должны сбрасываться
// стриками повторов (W0.2, план 2026-10-12-harness-module-audit-fixes).
import { describe, expect, it } from "vitest";
import { ToolBatchExecutor } from "../../src/core/agent/tool-batch";
import { createLoopState } from "../../src/core/agent/loop-state";
import { makeToolBatchDeps } from "../helpers/tool-batch-deps";

function makeExecutor(): ToolBatchExecutor {
  return new ToolBatchExecutor(
    makeToolBatchDeps({
      execute: async () => ({ success: true, output: "ok" }),
    }),
  );
}

async function runTool(
  ex: ToolBatchExecutor,
  state: ReturnType<typeof createLoopState>,
  name: string,
  args: Record<string, unknown>,
): Promise<void> {
  await ex.execute(state, [{ id: "1", name, arguments: args }], new Set(), "", "", "task");
}

describe("loop turn progress", () => {
  it("counts novel tool calls cumulatively, not as a streak", async () => {
    const ex = makeExecutor();
    const state = createLoopState();

    await runTool(ex, state, "web_search", { query: "a" });
    await runTool(ex, state, "web_search", { query: "a" });
    await runTool(ex, state, "web_search", { query: "b" });

    expect(state.duplicateBatches).toBe(1);
    expect(state.novelToolKeys.size).toBe(2);
    expect(state.totalBatches).toBe(3);
  });

  it("keeps progress after a non-duplicate batch resets the streak", async () => {
    const ex = makeExecutor();
    const state = createLoopState();

    await runTool(ex, state, "read_file", { path: "a.ts" });
    await runTool(ex, state, "read_file", { path: "a.ts" });
    await runTool(ex, state, "read_file", { path: "b.ts" });

    expect(state.consecutiveDuplicateBatches).toBe(0);
    expect(state.duplicateBatches).toBe(1);
    expect(state.totalBatches).toBe(3);
    expect(state.novelToolKeys.size).toBe(2);
  });
});
