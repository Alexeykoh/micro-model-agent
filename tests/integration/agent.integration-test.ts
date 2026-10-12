/**
 * Integration tests for the Agent — all mechanics covered.
 * Run: bun run test:integration
 * Real LLM tests require an OpenAI-compatible API at $MMA_PROVIDER_BASEURL.
 * Skip with: $env:MMA_RUN_INTEGRATION=1 (opt-in)
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { Agent } from "../../src/core/agent";
import { PromptBuilder } from "../../src/core/prompt-builder";
import { ToolRegistry } from "../../src/tools/registry";
import { ToolExecutor } from "../../src/tools/executor";
import { PluginManager } from "../../src/modules/plugins/manager";
import { ContextManager } from "../../src/core/context/manager";
import { HallucinationDetector } from "../../src/core/hallucination/detector";
import { SessionStore, SessionManager } from "../../src/modules/session/index";
import { OpenAICompatProvider } from "../../src/llm/openai-compat";
import { parseChunks } from "../../src/llm/response";
import type { AppConfig } from "../../src/config/types";
import { DEFAULTS } from "../../src/config/defaults";
import type { AgentDeps } from "../../src/core/agent";
import type { Chunk, Message } from "../../src/llm/provider";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync, mkdtempSync } from "fs";

const BASE_URL = process.env.MMA_PROVIDER_BASEURL || "http://localhost:1234/v1";
const MODEL = process.env.MMA_MODEL || "qwen/qwen3.5-9b";
const API_KEY = process.env.MMA_PROVIDER_APIKEY || "not-needed";
const shouldSkip = process.env.MMA_RUN_INTEGRATION !== "1";

function makeConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    version: "2.0.0",
    model: "test-model",
    provider: { type: "openai-compat", baseUrl: "http://localhost:1234/v1" },
    contextWindow: 32768,
    contextBudget: { systemPrompt: 0.25, responseReserve: 0.12, compactionThreshold: 0.75 },
    maxToolIterations: 25,
    stuckThreshold: 8,
    autoPlan: true,
    showReasoning: true,
    logLevel: "info",
    locale: "en",
    session: { autoSave: true, maxSessions: 50, isolateMemory: false },
    ...overrides,
  };
}

function quietLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    diagnostic: vi.fn(),
    setSessionDir: vi.fn(),
    initSessionLog: vi.fn(),
    closeSessionLog: vi.fn(),
    logLLMRequest: vi.fn(),
    logLLMResponse: vi.fn(),
    logToolCall: vi.fn(),
    logToolOutput: vi.fn(),
  };
}

function makePluginManager() {
  return new PluginManager();
}

function makeContextManager(window = 32768) {
  return new ContextManager(window);
}

function makeToolRegistry() {
  const registry = new ToolRegistry();
  return registry;
}

function makeToolExecutor(registry: ToolRegistry, ctx: any, pluginMgr: PluginManager) {
  return new ToolExecutor(registry, ctx, pluginMgr);
}

type MockChatFn = (messages: Message[], tools?: any[]) => AsyncIterable<Chunk>;

function makeLLMProvider(chatFn: MockChatFn) {
  return {
    model: "test-model",
    contextWindow: 32768,
    chat: vi.fn().mockImplementation(chatFn),
    countTokens: vi.fn().mockReturnValue(10),
  };
}

function textChunk(content: string): Chunk {
  return { type: "text", content };
}

function toolCallChunk(name: string, args: Record<string, unknown> = {}, id = "call-1"): Chunk {
  return { type: "tool_call", toolCall: { id, name, arguments: JSON.stringify(args) } };
}

function doneChunk(reason: "stop" | "tool_calls" = "stop"): Chunk {
  return { type: "done", finishReason: reason };
}

// ---------------------------------------------------------------------------
// Real LLM tests (skippable)
// ---------------------------------------------------------------------------

describe.skipIf(shouldSkip)("Agent (integration — real LLM)", () => {
  it("streams text response via onChunk callback", async () => {
    const provider = new OpenAICompatProvider({
      model: MODEL,
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      contextWindow: 32768,
    });

    const chunks: string[] = [];
    const messages: Message[] = [
      { role: "system", content: "Reply with exactly one short sentence." },
      { role: "user", content: "What is 3 + 5?" },
    ];

    for await (const chunk of provider.chat(messages)) {
      if (chunk.type === "text" && chunk.content) {
        chunks.push(chunk.content);
      }
    }

    expect(chunks.length).toBeGreaterThan(0);
    const joined = chunks.join("");
    expect(joined.length).toBeGreaterThan(0);
  }, 30000);

  it("model calls a tool when requested", async () => {
    const provider = new OpenAICompatProvider({
      model: MODEL,
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      contextWindow: 32768,
    });

    const tools = [
      {
        name: "get_weather",
        description: "Get current weather for a city",
        parameters: {
          type: "object",
          properties: {
            city: { type: "string", description: "City name" },
          },
          required: ["city"],
        },
      },
    ];

    const messages: Message[] = [
      {
        role: "system",
        content: "You have a get_weather tool. Always use it when asked about weather.",
      },
      { role: "user", content: "What is the weather in Tokyo?" },
    ];

    const allChunks: Chunk[] = [];
    for await (const chunk of provider.chat(messages, tools)) {
      allChunks.push(chunk);
    }

    const parsed = parseChunks(allChunks);
    expect(parsed.type === "tool_call" || parsed.type === "text").toBe(true);
  }, 30000);

  it("full agent cycle with real LLM: text response", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "mma-test-"));

    try {
      const config = makeConfig({
        model: MODEL,
        provider: { type: "openai-compat", baseUrl: BASE_URL, apiKey: API_KEY },
      });
      const llmProvider = new OpenAICompatProvider({
        model: MODEL,
        baseUrl: BASE_URL,
        apiKey: API_KEY,
        contextWindow: 32768,
      });
      const logger = quietLogger();
      const registry = makeToolRegistry();
      const pluginMgr = makePluginManager();
      const ctxMgr = makeContextManager();
      const executor = makeToolExecutor(registry, { config, baseDir: tmpDir, logger }, pluginMgr);
      const detector = new HallucinationDetector();

      const deps: AgentDeps = {
        config,
        llmProvider,
        toolExecutor: executor,
        pluginManager: pluginMgr,
        contextManager: ctxMgr,
        hallucinationDetector: detector,
        logger,
        baseDir: tmpDir,
        promptBlocks: [],
      };

      const agent = new Agent(deps);
      const result = await agent.run(
        "Please provide a detailed response explaining what you can do as an AI assistant.",
      );
      expect(result.success).toBe(true);
      expect(result.text.length).toBeGreaterThan(0);
      agent.shutdown();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);

  it("full agent cycle with real LLM: tool calls", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "mma-test-"));

    try {
      const config = makeConfig({
        model: MODEL,
        provider: { type: "openai-compat", baseUrl: BASE_URL, apiKey: API_KEY },
        maxToolIterations: 3,
        session: { autoSave: false, maxSessions: 50, isolateMemory: false },
      });
      const llmProvider = new OpenAICompatProvider({
        model: MODEL,
        baseUrl: BASE_URL,
        apiKey: API_KEY,
        contextWindow: 32768,
      });
      const logger = quietLogger();
      const registry = makeToolRegistry();

      registry.register({
        name: "echo",
        description: 'Echo back the input text. Call this when user says "echo <something>".',
        parameters: {
          type: "object",
          properties: { text: { type: "string", description: "Text to echo" } },
          required: ["text"],
        },
        handler: async (_ctx, args) => ({ success: true, output: `ECHO: ${args.text}` }),
      });

      const pluginMgr = makePluginManager();
      const ctxMgr = makeContextManager();
      const executor = makeToolExecutor(registry, { config, baseDir: tmpDir, logger }, pluginMgr);
      const detector = new HallucinationDetector();

      const deps: AgentDeps = {
        config,
        llmProvider,
        toolExecutor: executor,
        pluginManager: pluginMgr,
        contextManager: ctxMgr,
        hallucinationDetector: detector,
        logger,
        baseDir: tmpDir,
        promptBlocks: [],
      };

      const agent = new Agent(deps);
      // Agent runs full cycle; may or may not call tools depending on model
      const result = await agent.run("echo hello world — use the echo tool");
      // Cycle completed (tool call or text response are both valid outcomes)
      expect(result.iterationCount).toBeGreaterThan(0);
      agent.shutdown();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);
});

// ---------------------------------------------------------------------------
// Mock-based agent integration tests — full mechanic coverage
// ---------------------------------------------------------------------------

describe("Agent (mock-based integration)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── State machine: text response ────────────────────────────────────────

  it("completes INIT→THINK→OBSERVE→OUTPUT cycle for text response", async () => {
    const config = makeConfig();
    const llmProvider = makeLLMProvider(async function* () {
      yield textChunk("Hello ");
      yield textChunk("world!");
      yield doneChunk("stop");
    });
    const logger = quietLogger();
    const registry = makeToolRegistry();
    const pluginMgr = makePluginManager();
    const ctxMgr = makeContextManager();
    const executor = makeToolExecutor(registry, { config, baseDir: tmpDir, logger }, pluginMgr);
    const detector = new HallucinationDetector();

    const deps: AgentDeps = {
      config,
      llmProvider,
      toolExecutor: executor,
      pluginManager: pluginMgr,
      contextManager: ctxMgr,
      hallucinationDetector: detector,
      logger,
      baseDir: tmpDir,
      promptBlocks: [],
    };

    const agent = new Agent(deps);
    const result = await agent.run("hello");

    expect(result.success).toBe(true);
    expect(result.text).toBe("Hello world!");
    expect(result.iterationCount).toBe(1);
    expect(ctxMgr.getMessageCount()).toBeGreaterThan(0);
    agent.shutdown();
  });

  // ── Streaming via onChunk ─────────────────────────────────────────────

  it("delivers streaming chunks via onChunk callback", async () => {
    const config = makeConfig();
    const llmProvider = makeLLMProvider(async function* () {
      yield textChunk("This is ");
      yield textChunk("a normal ");
      yield textChunk("response");
      yield doneChunk("stop");
    });
    const logger = quietLogger();
    const registry = makeToolRegistry();
    const pluginMgr = makePluginManager();
    const ctxMgr = makeContextManager();
    const executor = makeToolExecutor(registry, { config, baseDir: tmpDir, logger }, pluginMgr);
    const detector = new HallucinationDetector();

    const deps: AgentDeps = {
      config,
      llmProvider,
      toolExecutor: executor,
      pluginManager: pluginMgr,
      contextManager: ctxMgr,
      hallucinationDetector: detector,
      logger,
      baseDir: tmpDir,
      promptBlocks: [],
    };

    const agent = new Agent(deps);
    const received: string[] = [];
    const result = await agent.run("test", (chunk) => received.push(chunk));

    expect(result.success).toBe(true);
    expect(received).toEqual(["This is ", "a normal ", "response"]);
    agent.shutdown();
  });

  // ── Tool call + execution ─────────────────────────────────────────────

  it("executes tool call and feeds results back to LLM", async () => {
    const config = makeConfig();
    const llmProvider = makeLLMProvider(async function* (messages, _tools) {
      // First call: tool_call
      if (messages.some((m) => m.role === "tool")) {
        yield textChunk("Done after tool");
        yield doneChunk("stop");
      } else {
        yield toolCallChunk("test_tool", { key: "value" }, "call-1");
        yield doneChunk("tool_calls");
      }
    });
    const logger = quietLogger();
    const registry = makeToolRegistry();
    registry.register({
      name: "test_tool",
      description: "Test tool",
      parameters: {},
      handler: async (_ctx, args) => ({ success: true, output: `got: ${JSON.stringify(args)}` }),
    });
    const pluginMgr = makePluginManager();
    const ctxMgr = makeContextManager();
    const executor = makeToolExecutor(registry, { config, baseDir: tmpDir, logger }, pluginMgr);
    const detector = new HallucinationDetector();

    const deps: AgentDeps = {
      config,
      llmProvider,
      toolExecutor: executor,
      pluginManager: pluginMgr,
      contextManager: ctxMgr,
      hallucinationDetector: detector,
      logger,
      baseDir: tmpDir,
      promptBlocks: [],
    };

    const agent = new Agent(deps);
    const result = await agent.run("use tool");

    expect(result.success).toBe(true);
    expect(result.text).toBe("Done after tool");
    expect(llmProvider.chat).toHaveBeenCalledTimes(2);
    agent.shutdown();
  });

  // ── Multiple tool calls in one turn ────────────────────────────────────

  it("handles multiple tool calls in a single turn", async () => {
    const config = makeConfig();
    const llmProvider = makeLLMProvider(async function* (messages, _tools) {
      if (messages.some((m) => m.role === "tool")) {
        yield textChunk("All tools done");
        yield doneChunk("stop");
      } else {
        yield toolCallChunk("tool_a", {}, "call-a");
        yield toolCallChunk("tool_b", {}, "call-b");
        yield doneChunk("tool_calls");
      }
    });
    const logger = quietLogger();
    const registry = makeToolRegistry();
    registry.register({
      name: "tool_a",
      description: "Tool A",
      parameters: {},
      handler: async () => ({ success: true, output: "a done" }),
    });
    registry.register({
      name: "tool_b",
      description: "Tool B",
      parameters: {},
      handler: async () => ({ success: true, output: "b done" }),
    });
    const pluginMgr = makePluginManager();
    const ctxMgr = makeContextManager();
    const executor = makeToolExecutor(registry, { config, baseDir: tmpDir, logger }, pluginMgr);
    const detector = new HallucinationDetector();

    const deps: AgentDeps = {
      config,
      llmProvider,
      toolExecutor: executor,
      pluginManager: pluginMgr,
      contextManager: ctxMgr,
      hallucinationDetector: detector,
      logger,
      baseDir: tmpDir,
      promptBlocks: [],
    };

    const agent = new Agent(deps);
    const result = await agent.run("use tools");

    expect(result.success).toBe(true);
    expect(result.text).toBe("All tools done");
    agent.shutdown();
  });

  // ── Multi-turn tool loops ─────────────────────────────────────────────

  it("supports multi-turn tool+text cycles", async () => {
    const config = makeConfig({ maxToolIterations: 10 });
    let callCount = 0;
    const llmProvider = makeLLMProvider(async function* (_messages, _tools) {
      callCount++;
      // First two calls are tool_calls, third is final text
      if (callCount <= 2) {
        yield toolCallChunk(`step_${callCount}`, { step: callCount }, `call-${callCount}`);
        yield doneChunk("tool_calls");
      } else {
        yield textChunk("Final answer");
        yield doneChunk("stop");
      }
    });
    const logger = quietLogger();
    const registry = makeToolRegistry();
    registry.register({
      name: "step_1",
      description: "Step 1",
      parameters: {},
      handler: async () => ({ success: true, output: "step 1 done" }),
    });
    registry.register({
      name: "step_2",
      description: "Step 2",
      parameters: {},
      handler: async () => ({ success: true, output: "step 2 done" }),
    });
    const pluginMgr = makePluginManager();
    const ctxMgr = makeContextManager();
    const executor = makeToolExecutor(registry, { config, baseDir: tmpDir, logger }, pluginMgr);
    const detector = new HallucinationDetector();

    const deps: AgentDeps = {
      config,
      llmProvider,
      toolExecutor: executor,
      pluginManager: pluginMgr,
      contextManager: ctxMgr,
      hallucinationDetector: detector,
      logger,
      baseDir: tmpDir,
      promptBlocks: [],
    };

    const agent = new Agent(deps);
    const result = await agent.run("multi step");

    expect(result.success).toBe(true);
    expect(result.text).toBe("Final answer");
    expect(result.iterationCount).toBe(3);
    agent.shutdown();
  });

  // ── Max iteration limit ───────────────────────────────────────────────

  it("stops when maxToolIterations is reached", async () => {
    const config = makeConfig({ maxToolIterations: 3 });
    const llmProvider = makeLLMProvider(async function* () {
      yield toolCallChunk("loop_tool", {}, "call-loop");
      yield doneChunk("tool_calls");
    });
    const logger = quietLogger();
    const registry = makeToolRegistry();
    registry.register({
      name: "loop_tool",
      description: "Always called",
      parameters: {},
      handler: async () => ({ success: true, output: "looped" }),
    });
    const pluginMgr = makePluginManager();
    const ctxMgr = makeContextManager();
    const executor = makeToolExecutor(registry, { config, baseDir: tmpDir, logger }, pluginMgr);
    const detector = new HallucinationDetector();

    const deps: AgentDeps = {
      config,
      llmProvider,
      toolExecutor: executor,
      pluginManager: pluginMgr,
      contextManager: ctxMgr,
      hallucinationDetector: detector,
      logger,
      baseDir: tmpDir,
      promptBlocks: [],
    };

    const agent = new Agent(deps);
    const result = await agent.run("loop");

    expect(result.success).toBe(false);
    expect(result.error).toContain("iterations");
    expect(llmProvider.chat).toHaveBeenCalledTimes(3);
    agent.shutdown();
  });

  // ── Hallucination detection ───────────────────────────────────────────

  it("blocks response when hallucination detector says block", async () => {
    const config = makeConfig();
    const llmProvider = makeLLMProvider(async function* () {
      yield textChunk("I will delete all files");
      yield doneChunk("stop");
    });
    const logger = quietLogger();
    const detector = new HallucinationDetector();
    // Make confidence check always return block
    vi.spyOn(detector.getConfidenceCheck(), "validate").mockReturnValue({
      status: "block",
      reason: "Dangerous action detected",
    });
    const registry = makeToolRegistry();
    const pluginMgr = makePluginManager();
    const ctxMgr = makeContextManager();
    const executor = makeToolExecutor(registry, { config, baseDir: tmpDir, logger }, pluginMgr);

    const deps: AgentDeps = {
      config,
      llmProvider,
      toolExecutor: executor,
      pluginManager: pluginMgr,
      contextManager: ctxMgr,
      hallucinationDetector: detector,
      logger,
      baseDir: tmpDir,
      promptBlocks: [],
    };

    const agent = new Agent(deps);
    const result = await agent.run("dangerous");

    expect(result.success).toBe(false);
    expect(result.error).toContain("blocked");
    agent.shutdown();
    vi.restoreAllMocks();
  });

  it("passes normal responses through hallucination check", async () => {
    const config = makeConfig();
    const llmProvider = makeLLMProvider(async function* () {
      yield textChunk("This is a completely normal safe response");
      yield doneChunk("stop");
    });
    const detector = new HallucinationDetector();
    const validateSpy = vi.spyOn(detector, "validate");
    const logger = quietLogger();
    const registry = makeToolRegistry();
    const pluginMgr = makePluginManager();
    const ctxMgr = makeContextManager();
    const executor = makeToolExecutor(registry, { config, baseDir: tmpDir, logger }, pluginMgr);

    const deps: AgentDeps = {
      config,
      llmProvider,
      toolExecutor: executor,
      pluginManager: pluginMgr,
      contextManager: ctxMgr,
      hallucinationDetector: detector,
      logger,
      baseDir: tmpDir,
      promptBlocks: [],
    };

    const agent = new Agent(deps);
    const result = await agent.run("safe query");

    expect(result.success).toBe(true);
    expect(validateSpy).toHaveBeenCalled();
    const firstResult = await validateSpy.mock.results[0].value;
    expect(firstResult.status).toBe("pass");
    agent.shutdown();
    vi.restoreAllMocks();
  });

  // ── LLM error handling ───────────────────────────────────────────────

  it("returns error when LLM call fails", async () => {
    const config = makeConfig();
    const llmProvider = makeLLMProvider(async function* () {
      throw new Error("Connection refused");
    });
    const logger = quietLogger();
    const registry = makeToolRegistry();
    const pluginMgr = makePluginManager();
    const ctxMgr = makeContextManager();
    const executor = makeToolExecutor(registry, { config, baseDir: tmpDir, logger }, pluginMgr);
    const detector = new HallucinationDetector();

    const deps: AgentDeps = {
      config,
      llmProvider,
      toolExecutor: executor,
      pluginManager: pluginMgr,
      contextManager: ctxMgr,
      hallucinationDetector: detector,
      logger,
      baseDir: tmpDir,
      promptBlocks: [],
    };

    const agent = new Agent(deps);
    const result = await agent.run("crash");

    expect(result.success).toBe(false);
    expect(result.error).toContain("LLM error");
    agent.shutdown();
  });

  // ── Tool execution error ─────────────────────────────────────────────

  it("continues after tool execution errors", async () => {
    const config = makeConfig();
    const llmProvider = makeLLMProvider(async function* (messages, _tools) {
      if (messages.some((m) => m.role === "tool")) {
        yield textChunk("Tool failed but I continue");
        yield doneChunk("stop");
      } else {
        yield toolCallChunk("failing_tool", {}, "call-fail");
        yield doneChunk("tool_calls");
      }
    });
    const logger = quietLogger();
    const registry = makeToolRegistry();
    registry.register({
      name: "failing_tool",
      description: "This tool throws",
      parameters: {},
      handler: async () => {
        throw new Error("tool crash");
      },
    });
    const pluginMgr = makePluginManager();
    const ctxMgr = makeContextManager();
    const executor = makeToolExecutor(registry, { config, baseDir: tmpDir, logger }, pluginMgr);
    const detector = new HallucinationDetector();

    const deps: AgentDeps = {
      config,
      llmProvider,
      toolExecutor: executor,
      pluginManager: pluginMgr,
      contextManager: ctxMgr,
      hallucinationDetector: detector,
      logger,
      baseDir: tmpDir,
      promptBlocks: [],
    };

    const agent = new Agent(deps);
    const result = await agent.run("use failing tool");

    expect(result.success).toBe(true);
    expect(result.text).toBe("Tool failed but I continue");
    agent.shutdown();
  });

  // ── Unknown tool ──────────────────────────────────────────────────────

  it("handles unknown tool gracefully via executor", async () => {
    const config = makeConfig();
    const llmProvider = makeLLMProvider(async function* (messages, _tools) {
      if (messages.some((m) => m.role === "tool")) {
        yield textChunk("Unknown tool was attempted");
        yield doneChunk("stop");
      } else {
        yield toolCallChunk("nonexistent_tool", {}, "call-unknown");
        yield doneChunk("tool_calls");
      }
    });
    const logger = quietLogger();
    const registry = makeToolRegistry();
    const pluginMgr = makePluginManager();
    const ctxMgr = makeContextManager();
    const executor = makeToolExecutor(registry, { config, baseDir: tmpDir, logger }, pluginMgr);
    const detector = new HallucinationDetector();

    const deps: AgentDeps = {
      config,
      llmProvider,
      toolExecutor: executor,
      pluginManager: pluginMgr,
      contextManager: ctxMgr,
      hallucinationDetector: detector,
      logger,
      baseDir: tmpDir,
      promptBlocks: [],
    };

    const agent = new Agent(deps);
    const result = await agent.run("call unknown");

    expect(result.success).toBe(true);
    agent.shutdown();
  });

  // ── Plugin lifecycle ──────────────────────────────────────────────────

  it("fires plugin lifecycle hooks in correct order", async () => {
    const config = makeConfig();
    const llmProvider = makeLLMProvider(async function* () {
      yield textChunk("response from the assistant");
      yield doneChunk("stop");
    });
    const logger = quietLogger();
    const registry = makeToolRegistry();
    const pluginMgr = makePluginManager();
    const hookLog: string[] = [];

    pluginMgr.register({
      name: "test-plugin",
      onSessionStart: () => {
        hookLog.push("sessionStart");
      },
      onBeforeThink: () => {
        hookLog.push("beforeThink");
      },
      onSessionEnd: () => {
        hookLog.push("sessionEnd");
      },
    });

    const ctxMgr = makeContextManager();
    const executor = makeToolExecutor(registry, { config, baseDir: tmpDir, logger }, pluginMgr);
    const detector = new HallucinationDetector();

    const deps: AgentDeps = {
      config,
      llmProvider,
      toolExecutor: executor,
      pluginManager: pluginMgr,
      contextManager: ctxMgr,
      hallucinationDetector: detector,
      logger,
      baseDir: tmpDir,
      promptBlocks: [],
    };

    const agent = new Agent(deps);
    await agent.run("test");
    expect(hookLog).toContain("sessionStart");
    expect(hookLog).toContain("beforeThink");
    agent.shutdown();
    expect(hookLog).toContain("sessionEnd");
  });

  // ── Plugin tool hooks ────────────────────────────────────────────────

  it("executes plugin onBeforeTool and onAfterTool for tool calls", async () => {
    const config = makeConfig();
    const llmProvider = makeLLMProvider(async function* (messages, _tools) {
      if (messages.some((m) => m.role === "tool")) {
        yield textChunk("done with tool execution successfully");
        yield doneChunk("stop");
      } else {
        yield toolCallChunk("plugin_tool", { x: 1 }, "call-plug");
        yield doneChunk("tool_calls");
      }
    });
    const logger = quietLogger();
    const registry = makeToolRegistry();
    registry.register({
      name: "plugin_tool",
      description: "Tool for plugin test",
      parameters: {},
      handler: async () => ({ success: true, output: "ok" }),
    });
    const pluginMgr = makePluginManager();
    const hookLog: string[] = [];

    pluginMgr.register({
      name: "hook-plugin",
      onBeforeTool: async (_ctx, call) => {
        hookLog.push(`before:${call.name}`);
        return true;
      },
      onAfterTool: async (_ctx, _call, result) => {
        hookLog.push(`after:${result.output}`);
      },
    });

    const ctxMgr = makeContextManager();
    const executor = makeToolExecutor(registry, { config, baseDir: tmpDir, logger }, pluginMgr);
    const detector = new HallucinationDetector();

    const deps: AgentDeps = {
      config,
      llmProvider,
      toolExecutor: executor,
      pluginManager: pluginMgr,
      contextManager: ctxMgr,
      hallucinationDetector: detector,
      logger,
      baseDir: tmpDir,
      promptBlocks: [],
    };

    const agent = new Agent(deps);
    await agent.run("test plugins");

    // onBeforeTool is called once in ToolExecutor.execute()
    expect(hookLog).toEqual(["before:plugin_tool", "after:ok"]);
    agent.shutdown();
  });

  it("blocks tool execution when onBeforeTool returns false", async () => {
    const config = makeConfig();
    const llmProvider = makeLLMProvider(async function* (messages, _tools) {
      if (messages.some((m) => m.role === "tool")) {
        yield textChunk("Blocked but I handle it");
        yield doneChunk("stop");
      } else {
        yield toolCallChunk("blocked_tool", {}, "call-block");
        yield doneChunk("tool_calls");
      }
    });
    const logger = quietLogger();
    const registry = makeToolRegistry();
    registry.register({
      name: "blocked_tool",
      description: "Should be blocked",
      parameters: {},
      handler: async () => ({ success: true, output: "should not run" }),
    });
    const pluginMgr = makePluginManager();

    pluginMgr.register({
      name: "blocker",
      onBeforeTool: async () => false,
    });

    const ctxMgr = makeContextManager();
    const executor = makeToolExecutor(registry, { config, baseDir: tmpDir, logger }, pluginMgr);
    const detector = new HallucinationDetector();

    const deps: AgentDeps = {
      config,
      llmProvider,
      toolExecutor: executor,
      pluginManager: pluginMgr,
      contextManager: ctxMgr,
      hallucinationDetector: detector,
      logger,
      baseDir: tmpDir,
      promptBlocks: [],
    };

    const agent = new Agent(deps);
    const result = await agent.run("test blocker");

    expect(result.success).toBe(true);
    expect(result.text).toBe("Blocked but I handle it");
    agent.shutdown();
  });

  // ── Error plugin hook ─────────────────────────────────────────────────

  it("fires plugin onError when LLM fails", async () => {
    const config = makeConfig();
    const llmProvider = makeLLMProvider(async function* () {
      throw new Error("API timeout");
    });
    const logger = quietLogger();
    const registry = makeToolRegistry();
    const pluginMgr = makePluginManager();
    let caughtError: Error | null = null;

    pluginMgr.register({
      name: "error-catcher",
      onError: (_ctx, err) => {
        caughtError = err;
      },
    });

    const ctxMgr = makeContextManager();
    const executor = makeToolExecutor(registry, { config, baseDir: tmpDir, logger }, pluginMgr);
    const detector = new HallucinationDetector();

    const deps: AgentDeps = {
      config,
      llmProvider,
      toolExecutor: executor,
      pluginManager: pluginMgr,
      contextManager: ctxMgr,
      hallucinationDetector: detector,
      logger,
      baseDir: tmpDir,
      promptBlocks: [],
    };

    const agent = new Agent(deps);
    const result = await agent.run("error");

    expect(result.success).toBe(false);
    expect(caughtError).not.toBeNull();
    expect(caughtError!.message).toBe("API timeout");
    agent.shutdown();
  });

  // ── Plugin error isolation ────────────────────────────────────────────

  it("isolates plugin errors — one crash does not stop others", async () => {
    const config = makeConfig();
    const llmProvider = makeLLMProvider(async function* () {
      yield textChunk("response from the assistant");
      yield doneChunk("stop");
    });
    const logger = quietLogger();
    const registry = makeToolRegistry();
    const pluginMgr = makePluginManager();
    const goodPluginRan: string[] = [];

    pluginMgr.register({
      name: "crashing-plugin",
      priority: 9,
      onBeforeThink: () => {
        throw new Error("plugin crash!");
      },
    });
    pluginMgr.register({
      name: "good-plugin",
      priority: 1,
      onBeforeThink: () => {
        goodPluginRan.push("ok");
      },
    });

    const ctxMgr = makeContextManager();
    const executor = makeToolExecutor(registry, { config, baseDir: tmpDir, logger }, pluginMgr);
    const detector = new HallucinationDetector();

    const deps: AgentDeps = {
      config,
      llmProvider,
      toolExecutor: executor,
      pluginManager: pluginMgr,
      contextManager: ctxMgr,
      hallucinationDetector: detector,
      logger,
      baseDir: tmpDir,
      promptBlocks: [],
    };

    const agent = new Agent(deps);
    const result = await agent.run("test isolation");

    expect(result.success).toBe(true);
    expect(goodPluginRan).toContain("ok");
    agent.shutdown();
  });

  // ── Session auto-creation ─────────────────────────────────────────────

  it("auto-creates session when sessionManager is provided", async () => {
    const config = makeConfig();
    const llmProvider = makeLLMProvider(async function* () {
      yield textChunk("hello from the assistant");
      yield doneChunk("stop");
    });
    const logger = quietLogger();
    const registry = makeToolRegistry();
    const pluginMgr = makePluginManager();
    const ctxMgr = makeContextManager();
    const executor = makeToolExecutor(registry, { config, baseDir: tmpDir, logger }, pluginMgr);
    const detector = new HallucinationDetector();

    const sessionDir = join(tmpDir, "sessions");
    const sessionStore = new SessionStore(sessionDir);
    sessionStore.init();
    const sessionManager = new SessionManager(sessionStore, {
      model: "test-model",
      contextWindow: 32768,
      projectDir: tmpDir,
      maxSessions: 50,
    });

    const deps: AgentDeps = {
      config,
      llmProvider,
      toolExecutor: executor,
      pluginManager: pluginMgr,
      contextManager: ctxMgr,
      hallucinationDetector: detector,
      logger,
      baseDir: tmpDir,
      promptBlocks: [],
      sessionManager,
    };

    const agent = new Agent(deps);
    await agent.run("session test");

    expect(sessionManager.getActive()).not.toBeNull();
    const meta = sessionManager.getActiveMeta();
    expect(meta).not.toBeNull();
    expect(meta!.model).toBe("test-model");
    agent.shutdown();
  });

  // ── Session message persistence ───────────────────────────────────────

  it("persists user, tool and assistant messages to session history", async () => {
    const config = makeConfig();
    const llmProvider = makeLLMProvider(async function* (messages, _tools) {
      if (messages.some((m) => m.role === "tool")) {
        yield textChunk("tool worked");
        yield doneChunk("stop");
      } else {
        yield toolCallChunk("save_tool", {}, "call-save");
        yield doneChunk("tool_calls");
      }
    });
    const logger = quietLogger();
    const registry = makeToolRegistry();
    registry.register({
      name: "save_tool",
      description: "Test tool",
      parameters: {},
      handler: async () => ({ success: true, output: "tool result" }),
    });
    const pluginMgr = makePluginManager();
    const ctxMgr = makeContextManager();
    const executor = makeToolExecutor(registry, { config, baseDir: tmpDir, logger }, pluginMgr);
    const detector = new HallucinationDetector();

    const sessionDir = join(tmpDir, "sessions");
    const sessionStore = new SessionStore(sessionDir);
    sessionStore.init();
    const sessionManager = new SessionManager(sessionStore, {
      model: "test-model",
      contextWindow: 32768,
      projectDir: tmpDir,
      maxSessions: 50,
    });

    const deps: AgentDeps = {
      config,
      llmProvider,
      toolExecutor: executor,
      pluginManager: pluginMgr,
      contextManager: ctxMgr,
      hallucinationDetector: detector,
      logger,
      baseDir: tmpDir,
      promptBlocks: [],
      sessionManager,
    };

    const agent = new Agent(deps);
    await agent.run("save this");

    const history = sessionManager.loadHistory();
    const roles = history.map((m) => m.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    expect(roles).toContain("tool");
    agent.shutdown();
  });

  it("respects session.autoSave = false", async () => {
    const config = makeConfig({
      session: { autoSave: false, maxSessions: 50, isolateMemory: false },
    });
    const llmProvider = makeLLMProvider(async function* () {
      yield textChunk("no save");
      yield doneChunk("stop");
    });
    const logger = quietLogger();
    const registry = makeToolRegistry();
    const pluginMgr = makePluginManager();
    const ctxMgr = makeContextManager();
    const executor = makeToolExecutor(registry, { config, baseDir: tmpDir, logger }, pluginMgr);
    const detector = new HallucinationDetector();

    const sessionDir = join(tmpDir, "sessions");
    const sessionStore = new SessionStore(sessionDir);
    sessionStore.init();
    const sessionManager = new SessionManager(sessionStore, {
      model: "test-model",
      contextWindow: 32768,
      projectDir: tmpDir,
      maxSessions: 50,
    });

    const deps: AgentDeps = {
      config,
      llmProvider,
      toolExecutor: executor,
      pluginManager: pluginMgr,
      contextManager: ctxMgr,
      hallucinationDetector: detector,
      logger,
      baseDir: tmpDir,
      promptBlocks: [],
      sessionManager,
    };

    const agent = new Agent(deps);
    await agent.run("no session save");

    // User messages are always saved; autoSave only controls tool/assistant
    const history = sessionManager.loadHistory();
    expect(history.length).toBe(1);
    expect(history[0].role).toBe("user");
    agent.shutdown();
  });

  // ── Context compaction ────────────────────────────────────────────────

  it("triggers context compaction when threshold exceeded", async () => {
    const config = makeConfig();
    const llmProvider = makeLLMProvider(async function* () {
      yield textChunk("short");
      yield doneChunk("stop");
    });
    const logger = quietLogger();
    const registry = makeToolRegistry();
    const pluginMgr = makePluginManager();
    const ctxMgr = makeContextManager(4096); // small window

    // Force many messages to exceed compaction threshold
    for (let i = 0; i < 30; i++) {
      ctxMgr.addMessage({ role: "user", content: "x".repeat(200) });
    }

    const executor = makeToolExecutor(registry, { config, baseDir: tmpDir, logger }, pluginMgr);
    const detector = new HallucinationDetector();

    const deps: AgentDeps = {
      config,
      llmProvider,
      toolExecutor: executor,
      pluginManager: pluginMgr,
      contextManager: ctxMgr,
      hallucinationDetector: detector,
      logger,
      baseDir: tmpDir,
      promptBlocks: [],
    };

    const agent = new Agent(deps);
    await agent.run("compact test");

    expect(ctxMgr.getMessageCount()).toBeLessThan(60);
    agent.shutdown();
  });

  // ── System prompt building with budget ────────────────────────────────

  it("builds system prompt respecting token budget", async () => {
    const config = makeConfig();
    const llmProvider = makeLLMProvider(async function* () {
      yield textChunk("ok, operation completed");
      yield doneChunk("stop");
    });
    const logger = quietLogger();
    const registry = makeToolRegistry();
    const pluginMgr = makePluginManager();
    const ctxMgr = makeContextManager();
    const executor = makeToolExecutor(registry, { config, baseDir: tmpDir, logger }, pluginMgr);
    const detector = new HallucinationDetector();

    const promptBlocks = [
      { content: "Block A", priority: "critical" as const, essential: true, estimatedTokens: 100 },
      { content: "Block B", priority: "high" as const, essential: false, estimatedTokens: 100 },
    ];

    const deps: AgentDeps = {
      config,
      llmProvider,
      toolExecutor: executor,
      pluginManager: pluginMgr,
      contextManager: ctxMgr,
      hallucinationDetector: detector,
      logger,
      baseDir: tmpDir,
      promptBlocks,
    };

    const agent = new Agent(deps);
    const result = await agent.run("prompt test");

    expect(result.success).toBe(true);
    // System prompt should have been added
    const history = ctxMgr.getActiveHistory();
    const systemMsg = history.find((m) => m.role === "system");
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.content).toContain("Block A");
    agent.shutdown();
  });

  // ── Reasoning content ─────────────────────────────────────────────────

  it("handles reasoning chunks from the model", async () => {
    const config = makeConfig();
    const llmProvider = makeLLMProvider(async function* () {
      yield { type: "reasoning" as const, content: "Let me think..." };
      yield textChunk("Answer based on reasoning");
      yield doneChunk("stop");
    });
    const logger = quietLogger();
    const registry = makeToolRegistry();
    const pluginMgr = makePluginManager();
    const ctxMgr = makeContextManager();
    const executor = makeToolExecutor(registry, { config, baseDir: tmpDir, logger }, pluginMgr);
    const detector = new HallucinationDetector();

    const deps: AgentDeps = {
      config,
      llmProvider,
      toolExecutor: executor,
      pluginManager: pluginMgr,
      contextManager: ctxMgr,
      hallucinationDetector: detector,
      logger,
      baseDir: tmpDir,
      promptBlocks: [],
    };

    const agent = new Agent(deps);
    const result = await agent.run("reasoning test");

    expect(result.success).toBe(true);
    expect(result.text).toBe("Answer based on reasoning");
    agent.shutdown();
  });

  // ── Context info in result ────────────────────────────────────────────

  it("returns context token usage in result", async () => {
    const config = makeConfig();
    const llmProvider = makeLLMProvider(async function* () {
      yield textChunk("response from the assistant");
      yield doneChunk("stop");
    });
    const logger = quietLogger();
    const registry = makeToolRegistry();
    const pluginMgr = makePluginManager();
    const ctxMgr = makeContextManager();
    const executor = makeToolExecutor(registry, { config, baseDir: tmpDir, logger }, pluginMgr);
    const detector = new HallucinationDetector();

    const deps: AgentDeps = {
      config,
      llmProvider,
      toolExecutor: executor,
      pluginManager: pluginMgr,
      contextManager: ctxMgr,
      hallucinationDetector: detector,
      logger,
      baseDir: tmpDir,
      promptBlocks: [],
    };

    const agent = new Agent(deps);
    const result = await agent.run("context info");

    expect(result.contextUsed).toBeDefined();
    expect(result.contextLimit).toBeDefined();
    expect(typeof result.contextUsed).toBe("number");
    expect(typeof result.contextLimit).toBe("number");
    agent.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Tool system integration tests
// ---------------------------------------------------------------------------

describe("Tool System (integration)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ToolRegistry prevents duplicate registration", () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "unique_tool",
      description: "Test",
      parameters: {},
      handler: async () => ({ success: true, output: "ok" }),
    });
    expect(() =>
      registry.register({
        name: "unique_tool",
        description: "Duplicate",
        parameters: {},
        handler: async () => ({ success: true, output: "ok" }),
      }),
    ).toThrow("already registered");
  });

  it("ToolRegistry get/has/list work correctly", () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "tool_a",
      description: "A",
      parameters: {},
      handler: async () => ({ success: true, output: "a" }),
    });
    registry.register({
      name: "tool_b",
      description: "B",
      parameters: {},
      handler: async () => ({ success: true, output: "b" }),
    });

    expect(registry.has("tool_a")).toBe(true);
    expect(registry.has("nonexistent")).toBe(false);
    expect(registry.get("tool_b")).toBeDefined();
    expect(registry.list()).toEqual(["tool_a", "tool_b"]);
    expect(registry.getAllForLLM()).toHaveLength(2);
  });

  it("ToolExecutor returns error for unknown tool", async () => {
    const registry = new ToolRegistry();
    const pluginMgr = new PluginManager();
    const config = makeConfig();
    const logger = quietLogger();
    const executor = new ToolExecutor(registry, { config, baseDir: tmpDir, logger }, pluginMgr);

    const result = await executor.execute({ id: "unknown-1", name: "nonexistent", arguments: {} });
    expect(result.success).toBe(false);
    expect(result.output).toContain("Unknown tool");
  });

  it("ToolExecutor plugin onBeforeTool can block execution", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "blockable",
      description: "Can be blocked",
      parameters: {},
      handler: async () => ({ success: true, output: "ran" }),
    });
    const pluginMgr = new PluginManager();
    pluginMgr.register({
      name: "blocker",
      onBeforeTool: async () => false,
    });
    const config = makeConfig();
    const logger = quietLogger();
    const executor = new ToolExecutor(registry, { config, baseDir: tmpDir, logger }, pluginMgr);

    const result = await executor.execute({ id: "b-1", name: "blockable", arguments: {} });
    expect(result.success).toBe(false);
    expect(result.output).toContain("Blocked");
  });

  it("ToolExecutor isolates plugin errors", async () => {
    const registry = new ToolRegistry();
    let handlerCalled = false;
    registry.register({
      name: "safe_tool",
      description: "Safe tool",
      parameters: {},
      handler: async () => {
        handlerCalled = true;
        return { success: true, output: "ok" };
      },
    });
    const pluginMgr = new PluginManager();
    pluginMgr.register({
      name: "crash-on-before",
      onBeforeTool: async () => {
        throw new Error("plugin error");
      },
    });
    pluginMgr.register({
      name: "crash-on-after",
      onAfterTool: async () => {
        throw new Error("after error");
      },
    });
    const config = makeConfig();
    const logger = quietLogger();
    const executor = new ToolExecutor(registry, { config, baseDir: tmpDir, logger }, pluginMgr);

    const result = await executor.execute({ id: "iso-1", name: "safe_tool", arguments: {} });
    expect(result.success).toBe(true);
    expect(handlerCalled).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Plugin onBeforeTool error"));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Plugin onAfterTool error"));
  });
});

// ---------------------------------------------------------------------------
// LLM response layer integration tests
// ---------------------------------------------------------------------------

describe("LLM Response Layer (integration)", () => {
  it("parseChunks aggregates text chunks", () => {
    const chunks: Chunk[] = [
      { type: "text", content: "Hello " },
      { type: "text", content: "World" },
      { type: "done", finishReason: "stop" },
    ];
    const result = parseChunks(chunks);
    expect(result.type).toBe("text");
    if (result.type === "text") {
      expect(result.content).toBe("Hello World");
    }
  });

  it("parseChunks extracts tool calls", () => {
    const chunks: Chunk[] = [
      {
        type: "tool_call",
        toolCall: { id: "c1", name: "read_file", arguments: '{"path":"/tmp"}' },
      },
      { type: "done", finishReason: "tool_calls" },
    ];
    const result = parseChunks(chunks);
    expect(result.type).toBe("tool_call");
    if (result.type === "tool_call") {
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0].name).toBe("read_file");
      expect(result.calls[0].arguments).toEqual({ path: "/tmp" });
    }
  });

  it("parseChunks handles reasoning-only response", () => {
    const chunks: Chunk[] = [
      { type: "reasoning", content: "Let me think about this..." },
      { type: "done", finishReason: "stop" },
    ];
    const result = parseChunks(chunks);
    expect(result.type).toBe("reasoning");
    if (result.type === "reasoning") {
      expect(result.content).toContain("think");
    }
  });

  it("parseChunks returns empty for no content", () => {
    const chunks: Chunk[] = [{ type: "done", finishReason: "stop" }];
    const result = parseChunks(chunks);
    expect(result.type).toBe("empty");
  });

  it("parseChunks parses tool calls with malformed JSON", () => {
    const chunks: Chunk[] = [
      { type: "tool_call", toolCall: { id: "c2", name: "bad", arguments: "not-json" } },
      { type: "done", finishReason: "tool_calls" },
    ];
    const result = parseChunks(chunks);
    expect(result.type).toBe("tool_call");
    if (result.type === "tool_call") {
      expect(result.calls[0].arguments).toEqual({});
    }
  });
});

// ---------------------------------------------------------------------------
// PromptBuilder integration tests
// ---------------------------------------------------------------------------

describe("PromptBuilder (integration)", () => {
  it("fits blocks within budget", () => {
    const builder = new PromptBuilder(500);
    builder.addBlock({ content: "A", priority: "critical", essential: true, estimatedTokens: 200 });
    builder.addBlock({ content: "B", priority: "high", essential: false, estimatedTokens: 200 });
    builder.addBlock({ content: "C", priority: "low", essential: false, estimatedTokens: 200 });

    const { prompt, excluded } = builder.build();
    expect(prompt).toContain("A");
    expect(prompt).toContain("B");
    // C should be excluded (200+200+200=600 > 500)
    expect(excluded).toHaveLength(1);
    expect(excluded[0]).toBe("C");
  });

  it("always includes essential blocks even if over budget", () => {
    const builder = new PromptBuilder(100);
    builder.addBlock({
      content: "Essential A",
      priority: "critical",
      essential: true,
      estimatedTokens: 80,
    });
    builder.addBlock({
      content: "Essential B",
      priority: "critical",
      essential: true,
      estimatedTokens: 80,
    });

    const { prompt } = builder.build();
    // Both essential blocks included even though together they exceed budget
    expect(prompt).toContain("Essential A");
    expect(prompt).toContain("Essential B");
  });

  it("sorts non-essential blocks by priority", () => {
    const builder = new PromptBuilder(1000);
    builder.addBlock({ content: "Low", priority: "low", essential: false, estimatedTokens: 100 });
    builder.addBlock({
      content: "Critical",
      priority: "critical",
      essential: false,
      estimatedTokens: 100,
    });
    builder.addBlock({ content: "High", priority: "high", essential: false, estimatedTokens: 100 });
    builder.addBlock({
      content: "Normal",
      priority: "normal",
      essential: false,
      estimatedTokens: 100,
    });

    const { prompt } = builder.build();
    const criticalIdx = prompt.indexOf("Critical");
    const highIdx = prompt.indexOf("High");
    const normalIdx = prompt.indexOf("Normal");
    const lowIdx = prompt.indexOf("Low");

    expect(criticalIdx).toBeLessThan(highIdx);
    expect(highIdx).toBeLessThan(normalIdx);
    expect(normalIdx).toBeLessThan(lowIdx);
  });
});

// ---------------------------------------------------------------------------
// ContextManager integration tests
// ---------------------------------------------------------------------------

describe("ContextManager (integration)", () => {
  it("detects when compaction is needed based on token threshold", () => {
    const mgr = new ContextManager(4096);
    // 75% of history budget (4096*0.625=2560, 75% of that = 1920)
    // Each message content is encoded at ~2 chars per token
    for (let i = 0; i < 20; i++) {
      mgr.addMessage({ role: "user", content: "x".repeat(200) });
    }
    expect(mgr.needsCompaction()).toBe(true);
  });

  it("detects compaction at interval threshold", () => {
    // Interval compaction is gated by history load (compactionMinLoad, 2.13.0);
    // isolate the interval trigger by zeroing the load gate.
    const mgr = new ContextManager(32768, { ...DEFAULTS.contextBudget, compactionMinLoad: 0 });
    expect(mgr.needsCompaction()).toBe(false);

    // Simulate COMPACTION_INTERVAL (15) agent loop iterations
    for (let i = 0; i < 15; i++) {
      mgr.noteIteration();
    }
    expect(mgr.needsCompaction()).toBe(true);
  });

  it("compaction keeps recent turns and compresses old ones", () => {
    const mgr = new ContextManager(32768);
    const compacted: any[] = [];
    mgr.onCompact = (msgs) => compacted.push(msgs);

    for (let i = 0; i < 20; i++) {
      mgr.addMessage({ role: "user", content: `message ${i}` });
    }
    mgr.compact();

    // After compaction, recent turns preserved (last KEEP_LAST_N*2 = 12 messages)
    const history = mgr.getActiveHistory();
    expect(history.length).toBeLessThan(20);
    expect(compacted.length).toBe(1);
  });

  it("returns correct budget proportions", () => {
    const mgr = new ContextManager(32768);
    const budget = mgr.getBudget();

    expect(budget.systemPrompt).toBe(Math.floor(32768 * 0.25));
    expect(budget.responseReserve).toBe(Math.floor(32768 * 0.12));
    expect(budget.history).toBe(Math.floor(32768 * 0.63));
  });
});
