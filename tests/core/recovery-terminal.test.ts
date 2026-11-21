// RCV-9: failure-терминал лечится сабагентом, а не обрывает решаемую задачу.
import { describe, it, expect } from "vitest";
import { isRecoverableTerminal, resetFailureCounters } from "../../src/modules/recovery/terminal";
import { createRecoveryGate } from "../../src/modules/recovery/gate";
import { createLoopState } from "../../src/core/agent/loop-state";
import type { RecoveryProposal } from "../../src/modules/recovery/client";
import type { ToolCall } from "../../src/core/types";
import type { ToolResult } from "../../src/tools/types";
import { RECOVERY_MAX_TERMINALS } from "../../src/modules/recovery/constants";

const call = (): ToolCall => ({ id: "c1", name: "bash", arguments: { command: "npm -v" } }) as ToolCall;
const bad = (): ToolResult => ({ success: false, output: "exit code 1" });
const logger = { diagnostic: () => undefined };

function gate(proposal: RecoveryProposal | null, outcomes: ToolResult[] = [{ success: true, output: "fixed" }]) {
  let i = 0;
  const executed: ToolCall[] = [];
  const g = createRecoveryGate({
    client: { propose: async (): Promise<RecoveryProposal | null> => proposal },
    availableTools: ["bash", "write_file"],
    logger,
    execute: async (c) => {
      executed.push(c);
      return outcomes[i++] ?? { success: true, output: "ok" };
    },
  });
  return { g, executed };
}

describe("RCV-9: recoverable terminals", () => {
  it("classifies only stuck reasons as recoverable", () => {
    expect(isRecoverableTerminal("failed_batches")).toBe(true);
    expect(isRecoverableTerminal("stalled")).toBe(true);
    expect(isRecoverableTerminal("duplicate")).toBe(true);
    expect(isRecoverableTerminal("silent")).toBe(true);
    expect(isRecoverableTerminal("soft_tool_budget")).toBe(false);
    expect(isRecoverableTerminal("max_iters")).toBe(false);
    expect(isRecoverableTerminal("cost_budget")).toBe(false);
  });

  it("resets failure streaks so the terminal does not re-fire immediately", () => {
    const state = createLoopState();
    state.consecutiveFailedBatches = 6;
    state.failedBatchesTotal = 16;
    state.consecutiveDuplicateBatches = 12;
    state.consecutiveSilentBatches = 14;
    state.recentBatchFailures.push(true, true);
    state.honestStopNudged = true;
    resetFailureCounters(state);
    expect(state.consecutiveFailedBatches).toBe(0);
    expect(state.failedBatchesTotal).toBe(0);
    expect(state.consecutiveDuplicateBatches).toBe(0);
    expect(state.consecutiveSilentBatches).toBe(0);
    expect(state.recentBatchFailures).toHaveLength(0);
    expect(state.honestStopNudged).toBe(false);
  });

  it("executes the corrected call through the provided executor", async () => {
    const { g, executed } = gate({ call: { name: "bash", arguments: { command: "npm install" } }, reason: "use workdir" });
    const state = createLoopState();
    expect(await g.recoverTerminal("stalled", state, "build app", call(), bad(), async (c) => {
      executed.push(c);
      return { success: true, output: "ok" };
    })).toBe(true);
    expect(executed).toHaveLength(1);
    expect(executed[0]!.arguments.command).toBe("npm install");
  });

  it("is bounded and fails open", async () => {
    const { g, executed } = gate({ call: { name: "bash", arguments: {} }, reason: "x" });
    const state = createLoopState();
    const run = () => g.recoverTerminal("failed_batches", state, "task", call(), bad(), async (c) => {
      executed.push(c);
      return { success: true, output: "ok" };
    });
    for (let i = 0; i < RECOVERY_MAX_TERMINALS + 2; i++) await run();
    expect(executed).toHaveLength(RECOVERY_MAX_TERMINALS);
    expect(await run()).toBe(false); // бюджет исчерпан

    const skipped = gate({ skip: true, reason: "no fix" });
    expect(await skipped.g.recoverTerminal("stalled", createLoopState(), "task", call(), bad(), async () => ({ success: true, output: "ok" }))).toBe(false);
  });
});
