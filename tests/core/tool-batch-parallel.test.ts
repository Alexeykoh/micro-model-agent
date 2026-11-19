import { describe, it, expect } from "vitest";
import { ToolBatchExecutor } from "../../src/core/agent/tool-batch";
import { createLoopState } from "../../src/core/agent/loop-state";
import { subagentTool } from "../../src/tools/subagent";
import { makeToolBatchDeps } from "../helpers/tool-batch-deps";
import type { ToolCall, ToolResult } from "../../src/tools/types";

/** Gate that blocks every handler until `release()`; tracks how many entered. */
function gate() {
  let started = 0;
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  const execute = async (call: ToolCall): Promise<ToolResult> => {
    started++;
    await wait;
    return { success: true, output: `done ${call.id}` };
  };
  return { execute, started: () => started, release: () => release() };
}

const parallelSubagent = { subagent: { parallelizable: true } };

describe("ToolBatchExecutor parallel run", () => {
  it("runs consecutive subagent calls concurrently", async () => {
    const g = gate();
    const ex = new ToolBatchExecutor(
      makeToolBatchDeps({ execute: g.execute, toolDefs: parallelSubagent }),
    );
    const calls: ToolCall[] = [
      { id: "1", name: "subagent", arguments: { task: "a" } },
      { id: "2", name: "subagent", arguments: { task: "b" } },
    ];
    const p = ex.execute(createLoopState(), calls, new Set(), "", "", "go", () => {}, () => {});
    await new Promise((r) => setTimeout(r, 20));
    // Both handlers entered before either resolved → concurrent.
    expect(g.started()).toBe(2);
    g.release();
    await p;
  });

  it("keeps non-parallelizable tool calls sequential", async () => {
    const g = gate();
    const ex = new ToolBatchExecutor(
      makeToolBatchDeps({ execute: g.execute, toolDefs: { bash: { parallelizable: false } } }),
    );
    const calls: ToolCall[] = [
      { id: "1", name: "bash", arguments: { command: "a" } },
      { id: "2", name: "bash", arguments: { command: "b" } },
    ];
    const p = ex.execute(createLoopState(), calls, new Set(), "", "", "go", () => {}, () => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(g.started()).toBe(1);
    g.release();
    await p;
  });

  it("preserves original call order in role:tool messages", async () => {
    const order: string[] = [];
    const ex = new ToolBatchExecutor(
      makeToolBatchDeps({
        toolDefs: parallelSubagent,
        execute: async (call) => {
          // Reverse-ish jitter: call 2 resolves first.
          await new Promise((r) => setTimeout(r, call.id === "1" ? 20 : 5));
          return { success: true, output: `done ${call.id}` };
        },
      }),
    );
    // Capture addMessage only for tool results.
    const deps = (ex as any).deps;
    deps.contextManager.addMessage = (m: any) => {
      if (m.role === "tool") order.push(String(m.tool_call_id));
    };
    await ex.execute(
      createLoopState(),
      [
        { id: "1", name: "subagent", arguments: { task: "a" } },
        { id: "2", name: "subagent", arguments: { task: "b" } },
      ],
      new Set(),
      "",
      "",
      "go",
      () => {},
      () => {},
    );
    expect(order).toEqual(["1", "2"]);
  });

  it("caps concurrency at maxParallelTasks", async () => {
    const g = gate();
    const ex = new ToolBatchExecutor(
      makeToolBatchDeps({ execute: g.execute, toolDefs: parallelSubagent, maxParallelTasks: 1 }),
    );
    const calls: ToolCall[] = [
      { id: "1", name: "subagent", arguments: { task: "a" } },
      { id: "2", name: "subagent", arguments: { task: "b" } },
      { id: "3", name: "subagent", arguments: { task: "c" } },
    ];
    const p = ex.execute(createLoopState(), calls, new Set(), "", "", "go", () => {}, () => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(g.started()).toBe(1);
    g.release();
    await p;
  });
});

describe("subagent capability flag", () => {
  it("is marked parallelizable", () => {
    expect(subagentTool.parallelizable).toBe(true);
  });
});
