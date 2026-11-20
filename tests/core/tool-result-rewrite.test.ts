// AQC-4: после повторного падения тула результат подменяется описанием
// наблюдаемого сбоя, вызов не исполняется, а пакет завершается (блок спарен
// со стопом). Текстовые «попробуй другой инструмент» здесь недостаточны.
import { describe, it, expect } from "vitest";
import { ToolBatchExecutor } from "../../src/core/agent/tool-batch";
import { createLoopState } from "../../src/core/agent/loop-state";
import { MAX_TOOL_FAILURES_PER_TURN } from "../../src/core/agent/constants";
import { makeToolBatchDeps } from "../helpers/tool-batch-deps";

describe("AQC-4: подмена результата проваленного тула", () => {
  it("описание сбоя становится наблюдаемым, а заблокированный вызов завершает пакет", async () => {
    const added: string[] = [];
    const executed: string[] = [];
    const ex = new ToolBatchExecutor(
      makeToolBatchDeps({
        added,
        execute: async (call) => {
          executed.push(call.name);
          return { success: false, output: `${call.name} boom: missing module` };
        },
      }),
    );
    const state = createLoopState();
    const call = { id: "1", name: "bash", arguments: {} };
    const run = () => ex.execute(state, [call], new Set(), "", "", "task");

    for (let i = 0; i < MAX_TOOL_FAILURES_PER_TURN; i++) await run();
    expect(state.disabledTools.has("bash")).toBe(true);

    let blocked: Awaited<ReturnType<typeof run>> | undefined;
    for (let i = 0; i < 6; i++) {
      blocked = await run();
      if (blocked.finalize) break;
    }
    expect(executed).toHaveLength(MAX_TOOL_FAILURES_PER_TURN);
    const messages = added.filter((m) => m.includes("missing module"));
    const message = messages[messages.length - 1];
    expect(message).toBeTruthy();
    expect(message).toMatch(/NOT executed|НЕ выполнен/);
    expect(blocked?.finalize).toBe("failed_batches");
  });
});
