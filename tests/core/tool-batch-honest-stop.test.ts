import { describe, it, expect } from "vitest";
import { ToolBatchExecutor } from "../../src/core/agent/tool-batch";
import { createLoopState } from "../../src/core/agent/loop-state";

// Honest-stop for retry loops (ses_mul5pepu_9mdq90): consecutive fully-failed
// batches (incl. tool-level [SECURITY BLOCKED]) must trigger a stop-and-answer
// directive, then a hard stop — instead of endless variant retrying.
function stubDeps(executeImpl: (call: { name: string }) => unknown, added: string[]) {
  return {
    config: { session: { autoSave: false } },
    toolExecutor: {
      execute: async (call: { name: string }) => executeImpl(call),
      getRegistry: () => ({ get: () => undefined }),
    },
    pluginManager: {
      runOnToolCall: () => {},
      runOnToolStart: () => {},
      runOnToolEnd: () => {},
      runOnMeta: (_ctx: unknown, chunk: string) => chunk,
    },
    contextManager: {
      addMessage: (m: { content: string }) => {
        added.push(typeof m.content === "string" ? m.content : "");
      },
      getEstimatedTokens: () => 0,
      getBudget: () => ({ history: 100_000 }),
    },
    hallucinationDetector: {
      getConsistencyCheck: () => ({ trackCreatedFile: () => {}, trackDeletedFile: () => {} }),
    },
    compactionService: { compactAfterTool: () => {} },
    logger: { debug: () => {}, diagnostic: () => {} },
    memoryStore: undefined,
    costTracker: { total: 0 },
    planSummary: () => null,
    getAbortSignal: () => undefined,
    isShutdownRequested: () => false,
    setScope: () => {},
  } as any;
}

const fail = { success: false, output: "[SECURITY BLOCKED] Command is not allowed" };
const ok = { success: true, output: "out" };

async function runBatch(ex: ToolBatchExecutor, state: ReturnType<typeof createLoopState>, results: unknown[]) {
  let i = 0;
  const impl = () => results[Math.min(i++, results.length - 1)];
  (ex as any).deps.toolExecutor.execute = async () => impl();
  return runSingleBatch(ex, state);
}

async function runSingleBatch(ex: ToolBatchExecutor, state: ReturnType<typeof createLoopState>) {
  return ex.execute(
    state,
    [{ id: "1", name: "bash", arguments: { command: "x" } }],
    new Set(),
    "",
    "",
    "task",
  );
}

async function runMixedBatch(ex: ToolBatchExecutor, state: ReturnType<typeof createLoopState>) {
  return ex.execute(
    state,
    [
      { id: "1", name: "bash", arguments: { command: "x" } },
      { id: "2", name: "read_file", arguments: { path: "f" } },
    ],
    new Set(),
    "",
    "",
    "task",
  );
}

function hasHonestStop(added: string[]): boolean {
  return added.some((m) => m.includes("STOP retrying") || m.includes("ХВАТИТ"));
}

function makeCase() {
  const added: string[] = [];
  const ex = new ToolBatchExecutor(stubDeps(() => fail, added));
  return { added, ex, state: createLoopState() };
}

describe("ToolBatchExecutor honest-stop", () => {
  it("directive on 4th consecutive failed batch, hard stop on 6th", async () => {
    const { added, ex, state } = makeCase();
    for (let n = 0; n < 3; n++) {
      const r = await runBatch(ex, state, [fail]);
      expect(r.interrupted).toBe(false);
    }
    expect(state.consecutiveFailedBatches).toBe(3);
    expect(hasHonestStop(added)).toBe(false);

    const fourth = await runBatch(ex, state, [fail]);
    expect(fourth.interrupted).toBe(false);
    expect(state.consecutiveFailedBatches).toBe(4);
    expect(hasHonestStop(added)).toBe(true);

    await runBatch(ex, state, [fail]);
    const sixth = await runBatch(ex, state, [fail]);
    expect(sixth.interrupted).toBe(true);
    expect(state.retryLoopStopped).toBe(true);
  });

  it("resets on success and on mixed batches", async () => {
    const { ex, state } = makeCase();
    await runBatch(ex, state, [fail]);
    await runBatch(ex, state, [fail]);
    expect(state.consecutiveFailedBatches).toBe(2);
    await runBatch(ex, state, [ok]);
    expect(state.consecutiveFailedBatches).toBe(0);

    // Mixed batch (fail + success in one batch) resets: debug loops with
    // successful edits between failures must not trip the stop.
    await runBatch(ex, state, [fail]);
    expect(state.consecutiveFailedBatches).toBe(1);
    (ex as any).deps.toolExecutor.execute = async (call: { name: string }) =>
      call.name === "bash" ? fail : ok;
    await runMixedBatch(ex, state);
    expect(state.consecutiveFailedBatches).toBe(0);
  });

  it("treats plugin-level blocks as neutral", async () => {
    // Guard-rail refusal before the tool ran is neither streak nor reset
    // per the ToolResult.blocked contract.
    const { ex, state } = makeCase();
    await runBatch(ex, state, [fail]);
    expect(state.consecutiveFailedBatches).toBe(1);
    (ex as any).deps.toolExecutor.execute = async () => ({
      success: false,
      blocked: true,
      output: "refused by plugin",
    });
    await runSingleBatch(ex, state);
    expect(state.consecutiveFailedBatches).toBe(1);
  });
});
