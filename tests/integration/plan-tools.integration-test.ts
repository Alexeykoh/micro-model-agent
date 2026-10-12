/**
 * Integration test: Agent uses plan and todo tools for multi-step tasks.
 * Verifies: plan creation, step updates, todo management.
 * Run: bun run test:integration
 * Real LLM tests require an OpenAI-compatible API at $MMA_PROVIDER_BASEURL.
 * Skip with: $env:MMA_RUN_INTEGRATION=1 (opt-in)
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { Agent } from "../../src/core/agent";
import { ToolRegistry } from "../../src/tools/registry";
import { ToolExecutor } from "../../src/tools/executor";
import { PluginManager } from "../../src/modules/plugins/manager";
import { ContextManager } from "../../src/core/context/manager";
import { HallucinationDetector } from "../../src/core/hallucination/detector";
import { ExecutionModule } from "../../src/modules/execution/module";
import { OpenAICompatProvider } from "../../src/llm/openai-compat";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync, mkdtempSync } from "fs";
import type { AppConfig } from "../../src/config/types";
import type { AgentDeps } from "../../src/core/agent";

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
    showReasoning: false,
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
    logLLMRequest: vi.fn(),
    logLLMResponse: vi.fn(),
    logToolCall: vi.fn(),
    logToolOutput: vi.fn(),
  };
}

describe.skipIf(shouldSkip)("Plan & Todo Tools (integration — real LLM)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-plan-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("agent creates a plan for multi-step task", async () => {
    const config = makeConfig({
      model: MODEL,
      provider: { type: "openai-compat", baseUrl: BASE_URL, apiKey: API_KEY },
      maxToolIterations: 10,
      session: { autoSave: false, maxSessions: 50, isolateMemory: false },
    });

    const llmProvider = new OpenAICompatProvider({
      model: MODEL,
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      contextWindow: 32768,
    });

    const logger = quietLogger();
    const registry = new ToolRegistry();
    const pluginManager = new PluginManager();
    const contextManager = new ContextManager();
    const hallucinationDetector = new HallucinationDetector();
    const executionModule = new ExecutionModule(tmpDir, config.stuckThreshold);

    // Register plan and todo tools from ExecutionModule
    const tools = executionModule.getToolDefinitions();
    for (const tool of tools) {
      registry.register(tool);
    }

    const toolExecutor = new ToolExecutor(
      registry,
      { config, baseDir: tmpDir, logger },
      pluginManager,
    );

    const deps: AgentDeps = {
      config,
      llmProvider,
      toolExecutor,
      pluginManager,
      contextManager,
      hallucinationDetector,
      logger,
      baseDir: tmpDir,
      promptBlocks: [],
    };

    const agent = new Agent(deps);

    try {
      const prompt = `Create a plan for building a simple web app with these steps:
1. Set up project structure
2. Create HTML file
3. Add CSS styling
4. Add JavaScript functionality

Use the plan tool to create this plan.`;

      const result = await agent.run(prompt);

      expect(result.success).toBe(true);
      expect(result.iterationCount).toBeGreaterThan(0);

      // Check that plan was created
      const tracker = executionModule.getTracker();
      expect(tracker).not.toBeNull();
      if (tracker) {
        const plan = tracker.getPlan();
        expect(plan.title).toBeTruthy();
        expect(plan.steps.length).toBeGreaterThan(0);
      }
    } finally {
      agent.shutdown();
    }
  }, 120000);

  it("agent updates plan step status", async () => {
    const config = makeConfig({
      model: MODEL,
      provider: { type: "openai-compat", baseUrl: BASE_URL, apiKey: API_KEY },
      maxToolIterations: 15,
      session: { autoSave: false, maxSessions: 50, isolateMemory: false },
    });

    const llmProvider = new OpenAICompatProvider({
      model: MODEL,
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      contextWindow: 32768,
    });

    const logger = quietLogger();
    const registry = new ToolRegistry();
    const pluginManager = new PluginManager();
    const contextManager = new ContextManager();
    const hallucinationDetector = new HallucinationDetector();
    const executionModule = new ExecutionModule(tmpDir, config.stuckThreshold);

    const tools = executionModule.getToolDefinitions();
    for (const tool of tools) {
      registry.register(tool);
    }

    const toolExecutor = new ToolExecutor(
      registry,
      { config, baseDir: tmpDir, logger },
      pluginManager,
    );

    const deps: AgentDeps = {
      config,
      llmProvider,
      toolExecutor,
      pluginManager,
      contextManager,
      hallucinationDetector,
      logger,
      baseDir: tmpDir,
      promptBlocks: [],
    };

    const agent = new Agent(deps);

    try {
      const prompt = `Create a plan with 3 steps:
1. Step one
2. Step two  
3. Step three

Then mark step 1 as done using the plan tool with action=update.`;

      const result = await agent.run(prompt);

      expect(result.success).toBe(true);

      const tracker = executionModule.getTracker();
      expect(tracker).not.toBeNull();
      if (tracker) {
        const step1 = tracker.getStep(1);
        expect(step1).toBeDefined();
        // Step should be marked as done
        expect(step1?.status).toBe("done");
      }
    } finally {
      agent.shutdown();
    }
  }, 120000);

  it("agent uses todo tool within plan step", async () => {
    const config = makeConfig({
      model: MODEL,
      provider: { type: "openai-compat", baseUrl: BASE_URL, apiKey: API_KEY },
      maxToolIterations: 15,
      session: { autoSave: false, maxSessions: 50, isolateMemory: false },
    });

    const llmProvider = new OpenAICompatProvider({
      model: MODEL,
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      contextWindow: 32768,
    });

    const logger = quietLogger();
    const registry = new ToolRegistry();
    const pluginManager = new PluginManager();
    const contextManager = new ContextManager();
    const hallucinationDetector = new HallucinationDetector();
    const executionModule = new ExecutionModule(tmpDir, config.stuckThreshold);

    const tools = executionModule.getToolDefinitions();
    for (const tool of tools) {
      registry.register(tool);
    }

    const toolExecutor = new ToolExecutor(
      registry,
      { config, baseDir: tmpDir, logger },
      pluginManager,
    );

    const deps: AgentDeps = {
      config,
      llmProvider,
      toolExecutor,
      pluginManager,
      contextManager,
      hallucinationDetector,
      logger,
      baseDir: tmpDir,
      promptBlocks: [],
    };

    const agent = new Agent(deps);

    try {
      const prompt = `Create a plan with 2 steps:
1. Setup project
2. Write code

Then use the todo tool to add sub-tasks to step 1: "Initialize git", "Create package.json"`;

      const result = await agent.run(prompt);

      expect(result.success).toBe(true);

      const tracker = executionModule.getTracker();
      expect(tracker).not.toBeNull();
    } finally {
      agent.shutdown();
    }
  }, 120000);
});
