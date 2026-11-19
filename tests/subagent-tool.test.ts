import { describe, it, expect, beforeEach } from "vitest";
import { setLocale } from "../src/i18n/index";

// Локаль — процессный синглтон: порядок файлов в раннере зависит от ФС
// (на CI иной), поэтому файлы с английскими строками пинят "en" сами.
beforeEach(() => setLocale("en"));
import { subagentTool } from "../src/tools/subagent";
import { ToolRegistry, ToolExecutor } from "../src/tools/index";
import { registerAllTools } from "../src/tools/index";

function makeCtx(overrides: Record<string, unknown> = {}) {
  const registry = new ToolRegistry();
  registerAllTools(registry);
  const executor = new ToolExecutor(registry, {
    logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
  } as any);
  return {
    baseDir: process.cwd(),
    config: {},
    logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    llmProvider: { chat: async () => {}, countTokens: () => 1 },
    toolExecutor: executor,
    sessionId: undefined,
    sessionContext: undefined,
    recursionDepth: 0,
    ...overrides,
  };
}

// A ctx whose ToolExecutor shares the SAME object, so recursion-depth writes
// on the handler ctx are what nested sub-agents actually read (mirrors the
// real bootstrap wiring, where toolCtx === executor.this.ctx).
function makeFullCtx(recursionDepth: number) {
  const registry = new ToolRegistry();
  registerAllTools(registry);
  const logger = {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
    logLLMRequest: () => {},
    logLLMResponse: () => {},
    logToolCall: () => {},
    logToolOutput: () => {},
    initSessionLog: () => {},
    closeSessionLog: () => {},
    setSessionDir: () => {},
  };
  const ctx: any = { logger, recursionDepth };
  const executor = new ToolExecutor(registry, ctx);
  ctx.baseDir = process.cwd();
  ctx.config = {
    model: "test-model",
    contextWindow: 4096,
    contextBudget: { systemPrompt: 0.25, responseReserve: 0.12, compactionThreshold: 0.75 },
    maxToolIterations: 3,
    stuckThreshold: 8,
    autoPlan: false,
    showReasoning: false,
    session: { autoSave: false },
    subagent: { resultMode: "text", maxSummaryChars: 2000, artifactsDir: ".mma/artifacts", stableSystemPrompt: true, maxParallelChunkQueries: 3 },
    ui: { showContextStats: false, showCompaction: false },
    security: { maxRecursionDepth: 3 },
  };
  ctx.toolExecutor = executor;
  ctx.llmProvider = {
    model: "test-model",
    contextWindow: 4096,
    chat: async function* () {
      yield { type: "text", content: "done" };
      yield { type: "done", finishReason: "stop" };
    },
    countTokens: () => 10,
  };
  ctx.sessionId = undefined;
  ctx.sessionContext = undefined;
  return ctx;
}

describe("subagent tool defensive guard", () => {
  it("should reject tool_tags that match no registered tools", async () => {
    const ctx = makeCtx();
    const result = await subagentTool.handler(ctx, {
      task: "create a file",
      tool_tags: ["file-write"],
    });
    expect(result.success).toBe(false);
    expect(String(result.output)).toContain("SECURITY BLOCKED");
    expect(String(result.output)).toContain("file-write");
  });

  it("should pass through tool_tags that match registered tools (not blocked by guard)", async () => {
    const ctx = makeCtx();
    const result = await subagentTool.handler(ctx, {
      task: "create a file",
      tool_tags: ["file"],
    });
    expect(String(result.output)).not.toContain("SECURITY BLOCKED");
    expect(String(result.output)).not.toContain("No tools match");
  });

  it("rejects an unknown expert_tag with the list of known experts", async () => {
    const ctx = makeCtx({ config: { experts: { research: { tool_tags: ["research"] } } } });
    const result = await subagentTool.handler(ctx, { task: "x", expert_tag: "web" });
    expect(result.success).toBe(false);
    expect(String(result.output)).toContain("Unknown expert_tag");
    expect(String(result.output)).toContain("research");
  });

  it("derives tool_tags from a configured expert_tag", async () => {
    const ctx = makeCtx({ config: { experts: { research: { tool_tags: ["research"] } } } });
    const result = await subagentTool.handler(ctx, { task: "search the web", expert_tag: "research" });
    expect(String(result.output)).not.toContain("Unknown expert_tag");
    expect(String(result.output)).not.toContain("No tools match");
  });

  it("uses subagent.maxDurationMs as the executor backstop", () => {
    const tm = subagentTool.timeoutMs;
    expect(typeof tm).toBe("function");
    const resolved = (tm as (ctx: unknown) => number)({
      config: { subagent: { timeoutMs: 45000, maxDurationMs: 600000 } },
    });
    expect(resolved).toBe(660000);
  });

  it("falls back to the default max duration for the executor backstop", () => {
    const tm = subagentTool.timeoutMs as (ctx: unknown) => number;
    expect(tm({ config: {} })).toBe(1860000);
  });

  it("increments recursion depth while the sub-agent runs and restores it after", async () => {
    const ctx = makeFullCtx(0);
    let observed: number | undefined;
    (ctx.llmProvider as any).chat = async function* () {
      observed = ctx.recursionDepth;
      yield { type: "text", content: "done" };
      yield { type: "done", finishReason: "stop" };
    };
    const result = await subagentTool.handler(ctx, { task: "hi" });
    expect(result.success).toBe(true);
    // Nested sub-agents (and any tool run during the sub-agent) see depth 1.
    expect(observed).toBe(1);
    expect(ctx.recursionDepth).toBe(0);
    expect(ctx.toolExecutor.getRecursionDepth()).toBe(0);
  });

  it("blocks a sub-agent when the recursion depth limit is reached", async () => {
    const ctx = makeFullCtx(3);
    const result = await subagentTool.handler(ctx, { task: "hi" });
    expect(result.success).toBe(false);
    expect(String(result.output)).toContain("SECURITY BLOCKED");
  });
});
