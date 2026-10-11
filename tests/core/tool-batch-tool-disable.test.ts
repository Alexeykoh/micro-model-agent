import { describe, it, expect } from "vitest";
import { ToolBatchExecutor } from "../../src/core/agent/tool-batch";
import { createLoopState } from "../../src/core/agent/loop-state";
import { MAX_TOOL_FAILURES_PER_TURN } from "../../src/core/agent/constants";
import { makeToolBatchDeps } from "../helpers/tool-batch-deps";

// A tool that can never succeed but whose failures are interleaved with
// successful calls must be disabled for the rest of the turn. Audited session
// ses_mv44qabg_s1przq: `browser` failed 17x (missing bridge-server.mjs) while
// web_search succeeded in between — batches never fully failed, so honest-stop
// never fired. This guard is per-tool total failures, not per-batch.
//
// Fully-failed single-tool loops are NOT the target here: their batch streak
// still drives the failed-batches terminal (threshold is above it), and this
// test interleaves a successful read_file batch to keep that streak at zero.
function runFailing(name: string) {
  const added: string[] = [];
  const ex = new ToolBatchExecutor(
    makeToolBatchDeps({
      execute: async (call) =>
        call.name === name ? { success: false, output: `${name} boom` } : { success: true, output: "ok" },
      added,
    }),
  );
  const state = createLoopState();
  const run = (callName: string) =>
    ex.execute(state, [{ id: "1", name: callName, arguments: { x: 1 } }], new Set(), "", "", "task");
  return { added, state, ex, run };
}

describe("ToolBatchExecutor per-turn tool disable", () => {
  it(`disables an interleaved repeatedly-failing tool after ${MAX_TOOL_FAILURES_PER_TURN} failures`, async () => {
    const { added, state, run } = runFailing("browser");

    for (let n = 0; n < MAX_TOOL_FAILURES_PER_TURN - 1; n++) {
      await run("browser"); // fail
      await run("read_file"); // success resets the consecutive-batch streak
      expect(state.disabledTools.has("browser")).toBe(false);
    }
    expect(state.toolFailureCounts.get("browser")?.count).toBe(MAX_TOOL_FAILURES_PER_TURN - 1);
    expect(state.consecutiveFailedBatches).toBe(0); // no failed-batch terminal in play

    await run("browser");
    expect(state.disabledTools.has("browser")).toBe(true);
    expect(state.toolDisabledNudged.has("browser")).toBe(true);
    expect(added.some((m) => m.includes("browser") && m.toLowerCase().includes("disabled"))).toBe(true);
  });

  it("does not disable a transient web tool (its failures are normal)", async () => {
    const { added, state, run } = runFailing("web_fetch");
    for (let n = 0; n < MAX_TOOL_FAILURES_PER_TURN + 3; n++) {
      await run("web_fetch");
      await run("read_file");
    }
    expect(state.disabledTools.size).toBe(0);
    expect(added.some((m) => m.toLowerCase().includes("disabled"))).toBe(false);
  });

  it("emits the disable directive only once", async () => {
    const { added, run } = runFailing("browser");
    for (let n = 0; n < MAX_TOOL_FAILURES_PER_TURN + 2; n++) {
      await run("browser");
      await run("read_file");
    }
    const directives = added.filter((m) => m.includes("browser") && m.toLowerCase().includes("disabled"));
    expect(directives).toHaveLength(1);
  });
});
