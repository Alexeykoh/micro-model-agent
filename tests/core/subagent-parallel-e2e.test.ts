import { describe, it, expect } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ToolBatchExecutor } from "../../src/core/agent/tool-batch";
import { createLoopState } from "../../src/core/agent/loop-state";
import { ToolRegistry, ToolExecutor, registerAllTools } from "../../src/tools/index";
import { PluginManager } from "../../src/modules/plugins/manager";
import { makeToolBatchDeps } from "../helpers/tool-batch-deps";
import type { ToolContext } from "../../src/tools/types";

/**
 * Deterministic end-to-end check of the real path: two `subagent` tool calls in
 * one batch -> ToolBatchExecutor detects `parallelizable` -> forks a real
 * ToolExecutor per call -> the real subagent handler spawns two children (via
 * the agentFactory seam) that overlap in time. No live model involved.
 */
describe("parallel subagents (end-to-end, scripted)", () => {
  function build() {
    const registry = new ToolRegistry();
    registerAllTools(registry);

    const baseDir = mkdtempSync(join(tmpdir(), "mma-par-e2e-"));
    const config: any = {
      model: "test-model",
      contextWindow: 4096,
      contextBudget: { systemPrompt: 0.25, responseReserve: 0.12, compactionThreshold: 0.75 },
      subagent: { resultMode: "text", maxSummaryChars: 2000, timeoutMs: 60000 },
      security: { maxRecursionDepth: 3, rateLimits: { maxRequestsPerMinute: 60, maxParallelTasks: 5 } },
      session: { autoSave: false },
      experts: {},
    };
    const logger: any = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      diagnostic: () => {},
      logToolCall: () => {},
      logToolOutput: () => {},
    };

    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // The child agent is stubbed: it just records that it started and waits.
    const agentFactory = () => ({
      run: async () => {
        started++;
        await gate;
        return { success: true, text: "sub result", iterationCount: 1, toolCalls: [] };
      },
    });

    const ctx: ToolContext = {
      baseDir,
      logger,
      llmProvider: { chat: async function* () {}, countTokens: () => 1 } as any,
      recursionDepth: 0,
      sessionId: "sess-e2e",
      config,
      agentFactory,
    } as any;
    const executor = new ToolExecutor(registry, ctx, new PluginManager());
    ctx.toolExecutor = executor;

    const deps = makeToolBatchDeps();
    deps.toolExecutor = executor;
    deps.config = config;
    const ex = new ToolBatchExecutor(deps);

    return {
      ex,
      started: () => started,
      release: () => release(),
      calls: [
        { id: "1", name: "subagent", arguments: { task: "read a" } },
        { id: "2", name: "subagent", arguments: { task: "read b" } },
      ],
    };
  }

  it("overlaps the two child agents", async () => {
    const { ex, started, release, calls } = build();
    const p = ex.execute(createLoopState(), calls, new Set(), "", "", "go", () => {}, () => {});
    await new Promise((r) => setTimeout(r, 30));
    // Both real subagent handlers spawned a child before either finished.
    expect(started()).toBe(2);
    release();
    await p;
  });
});
