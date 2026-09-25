import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Agent } from "../../src/core/agent";
import { SessionStore } from "../../src/modules/session/store";
import { SessionManager } from "../../src/modules/session/manager";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeAgent() {
  const tmpDir = mkdtempSync(join(tmpdir(), "mma-agent-autoname-"));
  tmpDirs.push(tmpDir);
  const store = new SessionStore(tmpDir);
  store.init();
  const sessionManager = new SessionManager(store, {
    model: "test-model",
    contextWindow: 4096,
    projectDir: tmpDir,
  });

  const mockProvider = {
    model: "test-model",
    contextWindow: 4096,
    chat: (messages: Array<{ content: unknown }>) => {
      const text = messages
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join("\n");
      const isTitle = text.includes("Give a short session title");
      return (async function* () {
        if (!isTitle) {
          yield { type: "text" as const, content: "Stub Title" };
        }
        yield { type: "done" as const, finishReason: "stop" as const };
      })();
    },
    countTokens: () => 10,
    listModels: async () => [],
  };

  const mockToolExecutor = {
    execute: () => Promise.resolve({ success: true, output: "tool ok" }),
    getToolDefinitions: () => [],
    getRegistry: () => ({ get: () => undefined }),
  };

  const mockPluginManager = {
    getAllPlugins: () => [],
    runOnBuildPrompt: () => [],
    runOnBeforeThink: () => {},
    runOnBeforeTool: () => Promise.resolve(true),
    runOnAfterTool: () => {},
    runOnAfterThink: () => {},
    runOnToolCall: () => {},
    runOnPhase: () => {},
    runOnToolStart: () => {},
    runOnToolEnd: () => {},
    runOnText: (_c: unknown, chunk: string) => chunk,
    runOnMeta: (_c: unknown, chunk: string) => chunk,
    runOnError: () => {},
    runOnSessionStart: () => {},
    runOnSessionEnd: () => {},
    runOnTurnEnd: () => {},
    setHostBridge: () => {},
  };

  const mockContextManager = {
    addMessage: () => {},
    getMessageCount: () => 0,
    needsCompaction: () => false,
    compact: () => {},
    getActiveHistory: () => [],
    getEstimatedTokens: () => 50,
    getBudget: () => ({ systemPrompt: 1024, responseReserve: 512, history: 2560 }),
    updateSystemPrompt: () => {},
    getCompactionCount: () => 0,
    getIterationsSinceCompaction: () => 0,
    getQuality: () => 100,
    noteIteration: () => {},
    setToolTokens: () => {},
    resetUserTurn: () => {},
  };

  const mockHallucinationDetector = {
    validate: () => ({ status: "pass" as const }),
    getConfidenceCheck: () => ({ setPreviousResponse: () => {} }),
    getConsistencyCheck: () => ({
      trackDecision: () => {},
      trackCreatedFile: () => {},
      trackDeletedFile: () => {},
    }),
  };

  const mockLogger = {
    debug: () => {},
    info: () => {},
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

  const deps = {
    config: {
      version: "2.0.0",
      model: "test-model",
      provider: { type: "openai-compat", baseUrl: "http://localhost:1234/v1" },
      orchestrator: {},
      moe: { enabled: false },
      experts: {},
      contextWindow: 4096,
      contextBudget: { systemPrompt: 0.25, responseReserve: 0.12, compactionThreshold: 0.75 },
      modelLoad: { autoLoad: false },
      retry: { maxRetries: 1, baseDelay: 10, maxDelay: 20 },
      maxToolIterations: 5,
      stuckThreshold: 8,
      autoPlan: false,
      showReasoning: true,
      logLevel: "info",
      locale: "en",
      session: { autoSave: true, maxSessions: 50, isolateMemory: false, autoName: true },
    },
    llmProvider: mockProvider,
    toolExecutor: mockToolExecutor,
    pluginManager: mockPluginManager,
    contextManager: mockContextManager,
    hallucinationDetector: mockHallucinationDetector,
    logger: mockLogger,
    baseDir: tmpDir,
    promptBlocks: [],
    sessionManager,
  } as any;

  const agent = new Agent(deps);
  return { agent, sessionManager };
}

describe("Agent session auto-name", () => {
  it("sets a deterministic name on the first message", async () => {
    const { agent, sessionManager } = makeAgent();
    await agent.run("Fix the login bug");
    expect(sessionManager.getActiveMeta()!.name).toBe("Fix the login bug");
    expect(sessionManager.getActiveMeta()!.nameSource).toBe("auto");
  });

  it("does not overwrite a manual name", async () => {
    const { agent, sessionManager } = makeAgent();
    sessionManager.rename(sessionManager.create("Manual").id, "Manual");
    await agent.run("Something else");
    expect(sessionManager.getActiveMeta()!.name).toBe("Manual");
  });
});
