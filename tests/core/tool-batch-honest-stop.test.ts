import { describe, it, expect, vi } from "vitest";
import { ToolBatchExecutor } from "../../src/core/agent/tool-batch";
import { createLoopState } from "../../src/core/agent/loop-state";
import { makeToolBatchDeps } from "../helpers/tool-batch-deps";

// Honest-stop for retry loops (ses_mul5pepu_9mdq90): consecutive fully-failed
// batches (incl. tool-level [SECURITY BLOCKED]) must trigger a stop-and-answer
// directive, then a hard stop — instead of endless variant retrying.
function stubDeps(executeImpl: (call: { name: string }) => unknown, added: string[]) {
  return makeToolBatchDeps({ execute: (call) => executeImpl(call) as never, added });
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

async function runBatchOf(
  ex: ToolBatchExecutor,
  state: ReturnType<typeof createLoopState>,
  calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
) {
  (ex as any).deps.toolExecutor.execute = async () => ok;
  return ex.execute(state, calls, new Set(), "", "", "task");
}

function hasDuplicateDirective(added: string[]): boolean {
  return added.some((m) => m.includes("repeated the same tool call") || m.includes("повторил один и тот же вызов"));
}

const sameCall = { id: "1", name: "read_file", arguments: { path: "src/a.ts" } };

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
    expect(sixth.finalize).toBe("failed_batches");
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

  it("counts plugin-level blocks as failures for honest-stop", async () => {
    // Guard-rail refusal before the tool ran is not a success, but a series of
    // refusals is still a loop — иначе счётчик замерзал навсегда (§1.7).
    const blocked = { success: false, blocked: true, output: "refused by plugin" };
    const added: string[] = [];
    const ex = new ToolBatchExecutor(stubDeps(() => blocked, added));
    const state = createLoopState();
    await runBatch(ex, state, [fail]);
    expect(state.consecutiveFailedBatches).toBe(1);
    await runSingleBatch(ex, state);
    expect(state.consecutiveFailedBatches).toBe(2);
    await runSingleBatch(ex, state);
    await runSingleBatch(ex, state);
    expect(state.consecutiveFailedBatches).toBe(4);
  });

  it("a blocked batch does not count as success and does not reset the streak", async () => {
    const added: string[] = [];
    const blocked = { success: false, blocked: true, output: "refused" };
    const ex = new ToolBatchExecutor(stubDeps(() => blocked, added));
    const state = createLoopState();
    await runSingleBatch(ex, state);
    await runSingleBatch(ex, state);
    expect(state.consecutiveFailedBatches).toBe(2);
    await runSingleBatch(ex, state);
    expect(state.consecutiveFailedBatches).toBe(3);
  });

  it("keeps the security-block marker across batches (script workaround)", async () => {
    // §1.8: bash заблокирован в пакете N, обход пишется в пакете N+1. Маркер
    // раньше сбрасывался в начале каждого пакета и nudge не срабатывал.
    const added: string[] = [];
    const blocked = {
      success: false,
      output: "[SECURITY BLOCKED] Command is not allowed: reg add",
    };
    const blocking = new ToolBatchExecutor(stubDeps(() => blocked, added));
    const state = createLoopState();
    await runSingleBatch(blocking, state);
    expect(state.sawSecurityBlock).toBe(true);

    const writing = new ToolBatchExecutor(stubDeps(() => ({ success: true, output: "written" }), added));
    await writing.execute(
      state,
      [{ id: "2", name: "write_file", arguments: { path: "run.cmd", content: "echo x" } }],
      new Set(),
      "",
      "",
      "task",
    );
    expect(state.scriptWorkaroundNudged).toBe(true);
    expect(added.some((m) => m.includes("script") || m.includes("скрипт"))).toBe(true);
  });
});

describe("ToolBatchExecutor duplicate budget", () => {
  it("varied reads are progress — never fires", async () => {
    const { added, ex, state } = makeCase();
    for (let n = 0; n < 20; n++) {
      const r = await runBatchOf(ex, state, [
        { id: String(n), name: "read_file", arguments: { path: `src/f${n}.ts` } },
      ]);
      expect(r.interrupted).toBe(false);
      expect(r.finalize).toBeUndefined();
    }
    expect(state.consecutiveDuplicateBatches).toBe(0);
    expect(hasDuplicateDirective(added)).toBe(false);
  });

  it("directive after 8 duplicate batches, finalize after 12", async () => {
    const { added, ex, state } = makeCase();
    await runBatchOf(ex, state, [sameCall]); // first = new, not a duplicate
    expect(state.consecutiveDuplicateBatches).toBe(0);
    for (let n = 0; n < 7; n++) {
      const r = await runBatchOf(ex, state, [sameCall]);
      expect(r.finalize).toBeUndefined();
    }
    expect(state.consecutiveDuplicateBatches).toBe(7); // 8 identical calls total
    const ninth = await runBatchOf(ex, state, [sameCall]);
    expect(ninth.finalize).toBeUndefined();
    expect(state.consecutiveDuplicateBatches).toBe(8);
    expect(hasDuplicateDirective(added)).toBe(true);
    for (let n = 0; n < 3; n++) await runBatchOf(ex, state, [sameCall]); // 10,11,12
    const thirteenth = await runBatchOf(ex, state, [sameCall]); // 13th identical
    expect(thirteenth.finalize).toBe("duplicate");
  });

  it("a fresh call resets the duplicate streak", async () => {
    const { ex, state } = makeCase();
    await runBatchOf(ex, state, [sameCall]); // new
    await runBatchOf(ex, state, [sameCall]); // dup → 1
    expect(state.consecutiveDuplicateBatches).toBe(1);
    await runBatchOf(ex, state, [
      { id: "9", name: "read_file", arguments: { path: "src/other.ts" } },
    ]);
    expect(state.consecutiveDuplicateBatches).toBe(0);
  });

  it("a pure process_log poll does not feed the streak", async () => {
    const { ex, state } = makeCase();
    const poll = { id: "1", name: "process_log", arguments: { id: "p1" } };
    for (let n = 0; n < 15; n++) {
      const r = await runBatchOf(ex, state, [poll]);
      expect(r.finalize).toBeUndefined();
    }
    expect(state.consecutiveDuplicateBatches).toBe(0);
  });
});

describe("ToolBatchExecutor failure-memory gating", () => {
  async function failTool(
    ex: ToolBatchExecutor,
    state: ReturnType<typeof createLoopState>,
    name: string,
    times: number,
  ) {
    (ex as any).deps.toolExecutor.execute = async () => ({
      success: false,
      output: "HTTP 404: Not Found",
    });
    for (let i = 0; i < times; i++) {
      await ex.execute(state, [{ id: "1", name, arguments: {} }], new Set(), "", "", "task");
    }
  }

  it("does not record transient web tool failures to memory", async () => {
    const ex = new ToolBatchExecutor(stubDeps(() => fail, []));
    const state = createLoopState();
    await failTool(ex, state, "web_fetch", 4);
    expect(state.memoryRuleRecorded.has("web_fetch")).toBe(false);
  });

  it("records a per-tool rule for one repeatedly failing tool", async () => {
    const ex = new ToolBatchExecutor(stubDeps(() => fail, []));
    const state = createLoopState();
    await failTool(ex, state, "bash", 4);
    expect(state.memoryRuleRecorded.has("bash")).toBe(true);
  });

  it("writes the generic systemic rule only when 3 different tools fail", async () => {
    const ex = new ToolBatchExecutor(stubDeps(() => fail, []));
    const appendRule = vi.fn();
    (ex as any).deps.memoryStore = { appendRule };
    const state = createLoopState();
    const systemic = () =>
      appendRule.mock.calls.some((c) => String(c[1]).includes("consecutive tool failures"));

    await failTool(ex, state, "bash", 4);
    await failTool(ex, state, "grep", 4);
    expect(systemic()).toBe(false);

    await failTool(ex, state, "read_file", 4);
    expect(systemic()).toBe(true);
  });
});
