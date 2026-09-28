import { describe, it, expect } from "vitest";
import { ToolBatchExecutor } from "../../src/core/agent/tool-batch";
import { createLoopState } from "../../src/core/agent/loop-state";
import type { MetaKind } from "../../src/core/types";

// ToolBatch marks display/output/diff/failure-gist onMeta calls with
// kind="tool" so quiet chat renderers can hide model-facing bodies while
// genuine status (context/compaction/warnings) stays visible.
function stubDeps(executeImpl: (call: { name: string }) => unknown) {
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
      addMessage: () => {},
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

describe("ToolBatchExecutor meta kinds", () => {
  it("marks display, output and diff as kind=tool", async () => {
    const seen: Array<{ meta: string; kind?: MetaKind }> = [];
    const ex = new ToolBatchExecutor(
      stubDeps((call) =>
        call.name === "write_file"
          ? { success: true, output: "MODEL-OUT", display: "DISP", diff: "DIFF" }
          : { success: true, output: "BASH-OUT" },
      ),
    );
    await ex.execute(
      createLoopState(),
      [
        { id: "1", name: "write_file", arguments: { path: "a.txt" } },
        { id: "2", name: "bash", arguments: { command: "echo hi" } },
      ],
      new Set(),
      "",
      "",
      "do things",
      () => {},
      (meta, kind) => {
        seen.push({ meta, kind });
      },
    );
    expect(seen).toHaveLength(3);
    expect(seen[0].meta).toContain("DISP");
    expect(seen[1].meta).toContain("DIFF");
    expect(seen[2].meta).toContain("BASH-OUT");
    for (const s of seen) expect(s.kind).toBe("tool");
  });
});
