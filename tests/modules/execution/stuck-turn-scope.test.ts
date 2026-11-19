/**
 * W1.3–W1.5: улики фейлов не отменяются посторонним успехом, а кулдаун
 * recovery не пересекает границы ходов (§1.2, §1.3, §1.11 аудита).
 */
import { describe, expect, it } from "vitest";
import { StuckDetector } from "../../../src/modules/execution/stuck-detector";
import {
  createExecutionPlugin,
  type ExecutionPluginState,
} from "../../../src/modules/execution/execution-plugin";

/** Состояние execution-плагина с нуля (как в модуле). */
function makeState(): ExecutionPluginState {
  return {
    lastRecoveryIteration: -5,
    lastTurnResetIteration: -1,
    lastRecoveryTurn: -1,
    lastStuckWarnTurn: -1,
    consecutivePlanWarnings: 0,
    lastStepId: -1,
    stuckNotified: false,
    lastStuckWarnKey: "",
    lastStuckWarnIter: -5,
    escalationDirectiveSent: false,
    depsGateHints: new Map<number, number>(),
    mutationsWithoutPlan: 0,
    planNudgeSent: false,
    typecheckFailures: new Map<string, string>(),
  };
}

function makePlugin() {
  const added: string[] = [];
  const state = makeState();
  const stuckDetector = new StuckDetector(6, 3, 5);
  const plugin = createExecutionPlugin({
    stuckDetector,
    trackerRef: { current: null },
    pendingMessages: [],
    forbiddenBashFailures: new Map<string, number>(),
    state,
    store: {} as never,
    checkPlanAlignment: () => null,
    advancePlanIfStepComplete: () => {},
    archiveCompletedPlan: () => {},
    maybeSearchError: () => {},
  } as never);
  const ctx = (iteration: number, turnSeq: number) => ({
    iteration,
    turnSeq,
    contextManager: { addMessage: (m: { content: string }) => added.push(m.content) },
    logger: { warn: () => {} },
    sessionLog: { plan: () => {}, directive: () => {} },
  });
  return { added, state, stuckDetector, plugin, ctx };
}

describe("stuck evidence window", () => {
  it("does not cancel accumulated failures on an unrelated success", () => {
    const sd = new StuckDetector(6, 3, 5);
    sd.recordToolError("bash", "ENOENT");
    sd.recordToolSuccess("read_file");
    sd.recordToolError("bash", "ENOENT");
    sd.recordToolSuccess("read_file");
    sd.recordToolError("bash", "ENOENT");
    expect(sd.hasConsecutiveFailures()).toBe(true);
  });

  it("clears only the counter of the tool that actually succeeded", () => {
    const sd = new StuckDetector(6, 3, 5);
    sd.recordToolError("bash", "ENOENT");
    sd.recordToolError("bash", "ENOENT");
    sd.recordToolError("bash", "ENOENT");
    sd.recordToolSuccess("bash");
    expect(sd.getToolErrorCount("bash")).toBe(2);
  });
});

describe("per-turn stuck progress", () => {
  it("keeps failure evidence inside one turn", () => {
    const { plugin, stuckDetector, ctx } = makePlugin();
    plugin.onBeforeThink(ctx(1, 1) as never);
    for (let i = 0; i < 3; i++) stuckDetector.recordToolError("bash", "ENOENT");
    plugin.onBeforeThink(ctx(2, 1) as never);
    expect(stuckDetector.hasConsecutiveFailures()).toBe(true);
  });

  it("resets the evidence once per new turn", () => {
    const { plugin, stuckDetector, ctx } = makePlugin();
    plugin.onBeforeThink(ctx(1, 1) as never);
    for (let i = 0; i < 3; i++) stuckDetector.recordToolError("bash", "ENOENT");
    plugin.onBeforeThink(ctx(1, 2) as never);
    expect(stuckDetector.hasConsecutiveFailures()).toBe(false);
  });

  it("applies the recovery cooldown inside the current turn", () => {
    const { plugin, state, stuckDetector, added, ctx } = makePlugin();
    // Прошлый ход дошёл до 30-й итерации и «съел» кулдаун recovery.
    state.lastRecoveryIteration = 30;
    state.lastRecoveryTurn = 1;
    plugin.onBeforeThink(ctx(1, 2) as never);
    for (let i = 0; i < 3; i++) stuckDetector.recordToolError("bash", "ENOENT");
    plugin.onBeforeThink(ctx(2, 2) as never);
    // Recovery сработал в новом ходу: кулдаун прошлого хода его не отнимает.
    expect(added.length).toBeGreaterThan(0);
    expect(state.lastRecoveryTurn).toBe(2);
    expect(state.lastRecoveryIteration).toBe(2);
  });
});
