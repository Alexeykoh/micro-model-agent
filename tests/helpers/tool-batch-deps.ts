import type { ToolCall, ToolResult } from "../../src/tools/types";

export interface ToolBatchDepsOptions {
  /** Handler used for both the serial path and per-call forks. */
  execute?: (call: ToolCall) => ToolResult | Promise<ToolResult>;
  /** Collect `<system-summary>`/tool message contents for assertions. */
  added?: string[];
  /** Cap for concurrent parallelizable calls (security.rateLimits). */
  maxParallelTasks?: number;
  /** Registry lookup by tool name (parallelizable/icon). */
  toolDefs?: Record<string, { parallelizable?: boolean; icon?: string }>;
}

/**
 * Shared ToolBatchExecutor dependency stub (de-duplicated across the
 * tool-batch tests). Returns a fresh object each call so tests can mutate
 * `deps.toolExecutor.execute` after construction.
 */
export function makeToolBatchDeps(opts: ToolBatchDepsOptions = {}): any {
  const execImpl =
    opts.execute ?? (async (): Promise<ToolResult> => ({ success: true, output: "out" }));
  const toolDefs = opts.toolDefs;
  const executor = {
    execute: (call: ToolCall) => execImpl(call),
    fork: () => ({ execute: (call: ToolCall) => execImpl(call) }),
    getRegistry: () => ({ get: (name: string) => toolDefs?.[name] }),
  };
  return {
    config: {
      session: { autoSave: false },
      security: {
        rateLimits: { maxRequestsPerMinute: 60, maxParallelTasks: opts.maxParallelTasks ?? 5 },
      },
    },
    toolExecutor: executor,
    pluginManager: {
      runOnToolCall: () => {},
      runOnToolStart: () => {},
      runOnToolEnd: () => {},
      runOnMeta: (_ctx: unknown, chunk: string) => chunk,
    },
    contextManager: {
      addMessage: (m: { content: string }) => {
        if (opts.added) opts.added.push(typeof m.content === "string" ? m.content : "");
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
