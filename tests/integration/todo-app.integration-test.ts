/**
 * Integration test: Agent builds a Vite + TS + Tailwind todo app.
 * Verifies: planning, todo tracking, file writing, bash, plugin lifecycle, error isolation.
 * Run: bun run test:integration
 * Real LLM tests require an OpenAI-compatible API at $MMA_PROVIDER_BASEURL.
 * Skip with: $env:MMA_RUN_INTEGRATION=1 (opt-in)
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { Agent } from "../../src/core/agent";
import { ToolRegistry } from "../../src/tools/registry";
import { ToolExecutor } from "../../src/tools/executor";
import { PluginManager } from "../../src/modules/plugins/manager";
import { ContextManager } from "../../src/modules/context/manager";
import { HallucinationDetector } from "../../src/modules/hallucination/detector";
import { SessionStore, SessionManager } from "../../src/modules/session/index";
import { OpenAICompatProvider } from "../../src/llm/openai-compat";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync, mkdtempSync, existsSync, readFileSync } from "fs";
import type { AppConfig } from "../../src/config/types";
import type { AgentDeps } from "../../src/core/agent";
import type { Chunk, Message } from "../../src/llm/provider";

const BASE_URL = process.env.MMA_PROVIDER_BASEURL || "http://localhost:1234/v1";
const MODEL = process.env.MMA_MODEL || "qwen/qwen3.5-9b";
const API_KEY = process.env.MMA_PROVIDER_APIKEY || "not-needed";
const shouldSkip = process.env.MMA_RUN_INTEGRATION !== "1";

function makeConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    version: "2.0.0",
    model: "test-model",
    provider: { type: "openai-compat", baseUrl: "http://localhost:1234/v1" },
    orchestrator: {},
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
function makeContextManager(w = 32768) {
  return new ContextManager(w);
}
function makeToolRegistry() {
  return new ToolRegistry();
}
function makeToolExecutor(r: ToolRegistry, ctx: any, p: PluginManager) {
  return new ToolExecutor(r, ctx, p);
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

// ═══════════════════════════════════════════════════════════════════════════════
// Real LLM tests — verify the model actually plans, uses tools, writes files
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(shouldSkip)("Todo App Build (integration — real LLM)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-todo-llm-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  interface TestTool {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    handler: (
      ctx: any,
      args: Record<string, unknown>,
    ) => Promise<{ success: boolean; output: string }>;
  }

  const PLAN_SCHEMA: Record<string, unknown> = {
    type: "object",
    properties: {
      action: { type: "string", enum: ["create", "update", "abort"], description: "Plan action" },
      title: { type: "string", description: "Plan title" },
      steps: { type: "array", items: { type: "string" }, description: "Plan steps" },
      step: { type: "number", description: "Step index to update" },
      status: { type: "string", enum: ["done", "failed", "skipped"], description: "Step status" },
    },
    required: ["action"],
  };

  const TODO_SCHEMA: Record<string, unknown> = {
    type: "object",
    properties: {
      action: { type: "string", enum: ["add", "done", "list"], description: "Todo action" },
      items: { type: "array", items: { type: "string" }, description: "Todo items" },
    },
    required: ["action"],
  };

  const WRITE_FILE_SCHEMA: Record<string, unknown> = {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to project root" },
      content: { type: "string", description: "File content to write" },
    },
    required: ["path", "content"],
  };

  const BASH_SCHEMA: Record<string, unknown> = {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      workdir: { type: "string", description: "Working directory (optional)" },
    },
    required: ["command"],
  };

  const ECHO_SCHEMA: Record<string, unknown> = {
    type: "object",
    properties: {
      message: { type: "string", description: "Text to echo back" },
    },
    required: ["message"],
  };

  function makeProvider() {
    return new OpenAICompatProvider({
      model: MODEL,
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      contextWindow: 32768,
      maxCompletionTokens: 4096,
    });
  }

  function buildAgent(config: AppConfig, tools: TestTool[]) {
    const provider = makeProvider();
    const registry = new ToolRegistry();
    for (const t of tools) {
      registry.register({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        handler: t.handler,
      });
    }
    const pluginMgr = new PluginManager();
    const ctxMgr = new ContextManager(32768);
    const logger = quietLogger();
    const executor = new ToolExecutor(registry, { config, baseDir: tmpDir, logger }, pluginMgr);
    const detector = new HallucinationDetector();
    const deps: AgentDeps = {
      config,
      llmProvider: provider,
      toolExecutor: executor,
      pluginManager: pluginMgr,
      contextManager: ctxMgr,
      hallucinationDetector: detector,
      logger,
      baseDir: tmpDir,
      promptBlocks: [],
    };
    return { agent: new Agent(deps), provider, ctxMgr };
  }

  // ── Model creates a plan for the todo app ─────────────────────────────────

  it("model creates a plan with plan tool when asked to build todo app", async () => {
    const config = makeConfig({
      model: MODEL,
      provider: { type: "openai-compat", baseUrl: BASE_URL, apiKey: API_KEY },
      maxToolIterations: 10,
      autoPlan: true,
      session: { autoSave: false, maxSessions: 50, isolateMemory: false },
    });

    let planCreated = false;
    const { agent } = buildAgent(config, [
      {
        name: "plan",
        description:
          "Create, update, or abort a multi-step execution plan. Use create to start a plan with steps, update to mark a step done/failed/skipped.",
        parameters: PLAN_SCHEMA,
        handler: async (_ctx, args) => {
          const action = String(args.action || "");
          if (action === "create") {
            planCreated = true;
            const steps = Array.isArray(args.steps) ? args.steps : [];
            return {
              success: true,
              output: `Plan created with ${steps.length} steps: ${steps.join(", ")}`,
            };
          }
          return { success: true, output: `Plan ${action}d` };
        },
      },
      {
        name: "todo",
        description:
          "Manage sub-tasks. Add items to a todo list, mark them done, or list current items.",
        parameters: TODO_SCHEMA,
        handler: async (_ctx, args) => {
          return {
            success: true,
            output: `Todo ${args.action}: ${(args.items || []).length} items`,
          };
        },
      },
    ]);

    const result = await agent.run(
      'Create a plan for a todo app: call plan with action=create, title="Todo App", 4 steps, and checks 1:1 with steps (file-exists:<path>, command:<cmd>, manual:<text>). Then call todo with action=add and 5 items. After BOTH tools complete, reply with ONLY one short sentence confirming the plan is ready. Do NOT call any more tools after todo.',
    );

    expect(result.success).toBe(true);
    expect(planCreated).toBe(true);
    agent.shutdown();
  }, 180000);

  // ── Model writes actual source files ──────────────────────────────────────

  it("model writes files via write_file tool and exits cleanly", async () => {
    const config = makeConfig({
      model: MODEL,
      provider: { type: "openai-compat", baseUrl: BASE_URL, apiKey: API_KEY },
      maxToolIterations: 25,
      session: { autoSave: false, maxSessions: 50, isolateMemory: false },
    });

    const writtenFiles: string[] = [];

    const { agent } = buildAgent(config, [
      {
        name: "write_file",
        description: "Create or overwrite a file with given content.",
        parameters: WRITE_FILE_SCHEMA,
        handler: async (ctx, args) => {
          const path = String(args.path);
          const baseDir = ctx.baseDir;
          const resolved = join(baseDir, path);
          if (!resolved.startsWith(baseDir))
            return { success: false, output: `Path not allowed: ${path}` };
          const { dirname } = await import("path");
          const { writeFileSync, mkdirSync, existsSync: ex } = await import("fs");
          const dir = dirname(resolved);
          if (!ex(dir)) mkdirSync(dir, { recursive: true });
          writeFileSync(resolved, String(args.content), "utf-8");
          writtenFiles.push(path);
          return { success: true, output: `Written ${path}` };
        },
      },
      {
        name: "plan",
        description: "Create or update a plan.",
        parameters: PLAN_SCHEMA,
        handler: async () => ({ success: true, output: "ok" }),
      },
      {
        name: "todo",
        description: "Manage sub-tasks.",
        parameters: TODO_SCHEMA,
        handler: async () => ({ success: true, output: "ok" }),
      },
    ]);

    const result = await agent.run(
      'Write file "hello.txt" with content "hello world" to the current directory. After writing it, reply with "Done" and STOP. Do NOT call any more tools.',
    );

    expect(result.success).toBe(true);
    expect(writtenFiles.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(tmpDir, "hello.txt"))).toBe(true);

    const content = readFileSync(join(tmpDir, "hello.txt"), "utf-8");
    expect(content).toContain("hello");

    agent.shutdown();
  }, 120000);

  // ── Full agent cycle: plan → todo → write → done ─────────────────────────

  it("completes full build cycle: model plans, tracks todos, writes files", async () => {
    const config = makeConfig({
      model: MODEL,
      provider: { type: "openai-compat", baseUrl: BASE_URL, apiKey: API_KEY },
      maxToolIterations: 15,
      session: { autoSave: false, maxSessions: 50, isolateMemory: false },
    });

    const toolCalls: string[] = [];
    const writtenFiles: string[] = [];

    const { agent } = buildAgent(config, [
      {
        name: "plan",
        description: "Create, update, or abort a multi-step execution plan.",
        parameters: PLAN_SCHEMA,
        handler: async (_ctx, args) => {
          toolCalls.push(`plan:${args.action}`);
          const steps = Array.isArray(args.steps) ? args.steps : [];
          return {
            success: true,
            output: `Plan "${args.title || "unnamed"}" with ${steps.length} steps: ${steps.join("; ")}`,
          };
        },
      },
      {
        name: "todo",
        description: "Manage sub-tasks. Add items, mark as done, or list current items.",
        parameters: TODO_SCHEMA,
        handler: async (_ctx, args) => {
          toolCalls.push(`todo:${args.action}`);
          const items = Array.isArray(args.items) ? args.items : [];
          return { success: true, output: `TODOs: ${items.join(", ")}` };
        },
      },
      {
        name: "write_file",
        description: "Create or overwrite a file with given content.",
        parameters: WRITE_FILE_SCHEMA,
        handler: async (ctx, args) => {
          toolCalls.push(`write_file:${args.path}`);
          const path = String(args.path);
          const baseDir = ctx.baseDir;
          const resolved = join(baseDir, path);
          if (!resolved.startsWith(baseDir)) return { success: false, output: `Path not allowed` };
          const { dirname } = await import("path");
          const { writeFileSync, mkdirSync, existsSync: ex } = await import("fs");
          const dir = dirname(resolved);
          if (!ex(dir)) mkdirSync(dir, { recursive: true });
          writeFileSync(resolved, String(args.content), "utf-8");
          writtenFiles.push(path);
          return { success: true, output: `Written ${path}` };
        },
      },
      {
        name: "bash",
        description: "Execute a shell command (mocked).",
        parameters: BASH_SCHEMA,
        handler: async (_ctx, args) => {
          toolCalls.push(`bash:${args.command}`);
          return { success: true, output: `[mocked] ${args.command}` };
        },
      },
    ]);

    const result = await agent.run(
      "Build a minimal Vite + TypeScript + Tailwind todo app. EXACT steps — do each ONCE then STOP:\n" +
        '1. call plan with action=create, title="Todo App", 4 steps, checks 1:1 with steps (file-exists:<path>, command:<cmd>, manual:<text>)\n' +
        "2. call todo with action=add and 5 items\n" +
        "3. call write_file 3 times: index.html, src/main.ts, src/style.css\n" +
        '4. call bash with command="npm install"\n' +
        '5. reply with ONLY "Build complete" and STOP — no more tool calls',
    );

    expect(result.success).toBe(true);

    expect(toolCalls.some((c) => c.startsWith("plan:create"))).toBe(true);
    expect(toolCalls.some((c) => c.startsWith("todo:add"))).toBe(true);
    expect(toolCalls.filter((c) => c.startsWith("write_file:")).length).toBeGreaterThanOrEqual(3);

    expect(writtenFiles.length).toBeGreaterThanOrEqual(3);
    expect(existsSync(join(tmpDir, "index.html"))).toBe(true);
    expect(existsSync(join(tmpDir, "src", "main.ts"))).toBe(true);
    expect(existsSync(join(tmpDir, "src", "style.css"))).toBe(true);

    expect(result.iterationCount).toBeGreaterThanOrEqual(4);

    agent.shutdown();
  }, 300000);

  // ── Model respects plan→step flow ────────────────────────────────────────

  it("model updates plan steps sequentially during build", async () => {
    const config = makeConfig({
      model: MODEL,
      provider: { type: "openai-compat", baseUrl: BASE_URL, apiKey: API_KEY },
      maxToolIterations: 12,
      session: { autoSave: false, maxSessions: 50, isolateMemory: false },
    });

    const planUpdates: string[] = [];

    const { agent } = buildAgent(config, [
      {
        name: "plan",
        description: "Create, update, or abort a multi-step execution plan.",
        parameters: PLAN_SCHEMA,
        handler: async (_ctx, args) => {
          const action = String(args.action || "");
          if (action === "create") {
            const steps = Array.isArray(args.steps) ? args.steps : [];
            planUpdates.push(`create:${steps.length}steps`);
            return { success: true, output: `Plan created with ${steps.length} steps.` };
          }
          if (action === "update") {
            planUpdates.push(`update:step${args.step}=${args.status}`);
            return { success: true, output: `Step ${args.step} marked as ${args.status}` };
          }
          return { success: true, output: `Plan ${action}` };
        },
      },
      {
        name: "todo",
        description: "Manage sub-tasks. Add items, mark as done, or list current items.",
        parameters: TODO_SCHEMA,
        handler: async (_ctx, args) => ({ success: true, output: `Todo ${args.action}` }),
      },
      {
        name: "write_file",
        description: "Create or overwrite a file with given content.",
        parameters: WRITE_FILE_SCHEMA,
        handler: async (ctx, args) => {
          const path = String(args.path);
          const baseDir = ctx.baseDir;
          const resolved = join(baseDir, path);
          if (!resolved.startsWith(baseDir)) return { success: false, output: `Path not allowed` };
          const { dirname } = await import("path");
          const { writeFileSync, mkdirSync, existsSync: ex } = await import("fs");
          const dir = dirname(resolved);
          if (!ex(dir)) mkdirSync(dir, { recursive: true });
          writeFileSync(resolved, String(args.content), "utf-8");
          return { success: true, output: `Written ${path}` };
        },
      },
      {
        name: "bash",
        description: "Execute a shell command (mocked).",
        parameters: BASH_SCHEMA,
        handler: async (_ctx, args) => ({ success: true, output: `[mocked] ${args.command}` }),
      },
    ]);

    const result = await agent.run(
      'EXACT sequence — do each ONCE then reply "Done" and STOP:\n' +
        '1. call plan action=create title="Todo" steps=["step1","step2","step3"]\n' +
        "2. call plan action=update step=1 status=done\n" +
        "3. call plan action=update step=2 status=done\n" +
        "4. call plan action=update step=3 status=done\n" +
        '5. reply "All steps done" — no more tools',
    );

    expect(result.success).toBe(true);
    expect(planUpdates.some((u) => u.startsWith("create:"))).toBe(true);
    expect(planUpdates.some((u) => u.startsWith("update:"))).toBe(true);

    agent.shutdown();
  }, 300000);

  // ── Model isolates paths — won't write outside baseDir ───────────────────

  it("model respects path isolation when LLM tries path traversal", async () => {
    const config = makeConfig({
      model: MODEL,
      provider: { type: "openai-compat", baseUrl: BASE_URL, apiKey: API_KEY },
      maxToolIterations: 8,
      session: { autoSave: false, maxSessions: 50, isolateMemory: false },
    });

    const writeAttempts: string[] = [];

    const { agent } = buildAgent(config, [
      {
        name: "write_file",
        description: "Create or overwrite a file with given content.",
        parameters: WRITE_FILE_SCHEMA,
        handler: async (ctx, args) => {
          const path = String(args.path);
          const baseDir = ctx.baseDir;
          const resolved = join(baseDir, path);
          writeAttempts.push(path);
          if (!resolved.startsWith(baseDir)) {
            return {
              success: false,
              output: `SECURITY BLOCK: ${path} is outside allowed directory`,
            };
          }
          const { dirname } = await import("path");
          const { writeFileSync, mkdirSync, existsSync: ex } = await import("fs");
          const dir = dirname(resolved);
          if (!ex(dir)) mkdirSync(dir, { recursive: true });
          writeFileSync(resolved, String(args.content), "utf-8");
          return { success: true, output: `Written ${path}` };
        },
      },
      {
        name: "plan",
        description: "Create or update a plan.",
        parameters: PLAN_SCHEMA,
        handler: async () => ({ success: true, output: "ok" }),
      },
      {
        name: "todo",
        description: "Manage sub-tasks.",
        parameters: TODO_SCHEMA,
        handler: async () => ({ success: true, output: "ok" }),
      },
    ]);

    const result = await agent.run(
      'Write file "safe.txt" with content "hello" in the current directory. Do not write anything else.',
    );

    expect(result.success).toBe(true);
    expect(writeAttempts.some((f) => f === "safe.txt" || f.includes("safe"))).toBe(true);

    agent.shutdown();
  }, 180000);

  // ── Session persistence with real LLM ────────────────────────────────────

  it("persists user, assistant and tool messages to session on disk", async () => {
    const config = makeConfig({
      model: MODEL,
      provider: { type: "openai-compat", baseUrl: BASE_URL, apiKey: API_KEY },
      maxToolIterations: 25,
      session: { autoSave: true, maxSessions: 50, isolateMemory: false },
    });

    const sessionDir = join(tmpDir, "sessions");
    const sessionStore = new SessionStore(sessionDir);
    sessionStore.init();
    const sessionManager = new SessionManager(sessionStore, {
      model: MODEL,
      contextWindow: 32768,
      projectDir: tmpDir,
      maxSessions: 50,
    });

    const provider = makeProvider();

    const registry = new ToolRegistry();
    registry.register({
      name: "echo",
      description: "Echo back a message. Call this when asked to echo.",
      parameters: {
        type: "object",
        properties: { message: { type: "string", description: "Text to echo" } },
        required: ["message"],
      },
      handler: async (_ctx, args) => {
        return { success: true, output: `ECHO: ${args.message}` };
      },
    });

    const pluginMgr = new PluginManager();
    const ctxMgr = new ContextManager(32768);
    const logger = quietLogger();
    const executor = new ToolExecutor(registry, { config, baseDir: tmpDir, logger }, pluginMgr);
    const detector = new HallucinationDetector();

    const deps: AgentDeps = {
      config,
      llmProvider: provider,
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
    const result = await agent.run('Echo "Hello Session" using the echo tool');

    expect(result.success).toBe(true);

    // Session was auto-created
    const activeId = sessionManager.getActive();
    expect(activeId).not.toBeNull();

    // Messages persisted to disk
    const history = sessionManager.loadHistory();
    expect(history.length).toBeGreaterThan(0);

    const roles = history.map((m) => m.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");

    agent.shutdown();
  }, 120000);
});

// ─── Full Todo App build flow (mock-based) ────────────────────────────────────

describe("Todo App Build (mock-based integration)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-todo-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("completes a multi-turn plan→todo→write→bash→done flow", async () => {
    const config = makeConfig({ maxToolIterations: 10 });
    let turn = 0;

    const llmProvider = makeLLMProvider(async function* () {
      turn++;
      if (turn === 1) {
        yield toolCallChunk(
          "plan",
          {
            action: "create",
            title: "Vite Todo App",
            steps: [
              "Scaffold project",
              "Add Tailwind CSS",
              "Build Todo UI + logic",
              "Verify build",
            ],
          },
          "plan-1",
        );
        yield doneChunk("tool_calls");
      } else if (turn === 2) {
        yield toolCallChunk(
          "todo",
          {
            action: "add",
            items: [
              "scaffold vite+ts project",
              "configure tailwind",
              "build todo list UI",
              "add todo CRUD logic",
              "verify build",
            ],
          },
          "todo-1",
        );
        yield doneChunk("tool_calls");
      } else if (turn === 3) {
        yield toolCallChunk(
          "write_file",
          {
            path: "index.html",
            content:
              '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8" />\n  <title>Todo App</title>\n</head>\n<body>\n  <div id="app"></div>\n  <script type="module" src="/src/main.ts"></script>\n</body>\n</html>',
          },
          "wf-html",
        );
        yield toolCallChunk(
          "write_file",
          {
            path: "src/main.ts",
            content:
              'import "./style.css"\n\ninterface Todo {\n  id: number\n  text: string\n  done: boolean\n}\n\nconst todos: Todo[] = []\nlet nextId = 1\n\nconst app = document.getElementById("app")!\napp.innerHTML = `<h1>Todo App</h1><input id="new-todo" placeholder="Add todo..." /><ul id="list"></ul>`\n',
          },
          "wf-ts",
        );
        yield toolCallChunk(
          "write_file",
          {
            path: "src/style.css",
            content:
              "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\nbody { @apply bg-gray-100 text-gray-900; }",
          },
          "wf-css",
        );
        yield doneChunk("tool_calls");
      } else if (turn === 4) {
        yield toolCallChunk("bash", { command: "npm install", workdir: tmpDir }, "bash-install");
        yield doneChunk("tool_calls");
      } else {
        yield textChunk("Todo app created successfully. Run `npm run dev` to start.");
        yield doneChunk("stop");
      }
    });

    const logger = quietLogger();
    const registry = makeToolRegistry();
    const callLog: string[] = [];

    // real write_file tool
    registry.register({
      name: "write_file",
      description: "Create or overwrite a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
      handler: async (ctx, args) => {
        const { join: j, dirname } = await import("path");
        const { writeFileSync, mkdirSync, existsSync } = await import("fs");
        const path = String(args.path);
        const baseDir = ctx.baseDir;
        const resolved = j(baseDir, path);
        if (!resolved.startsWith(baseDir))
          return { success: false, output: `Path not allowed: ${path}` };
        const dir = dirname(resolved);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(resolved, String(args.content), "utf-8");
        callLog.push(`write_file:${path}`);
        return { success: true, output: `Written ${path}` };
      },
    });

    // plan tool
    registry.register({
      name: "plan",
      description: "Create, update, or abort a multi-step execution plan",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["create", "update", "abort"] },
          title: { type: "string" },
          steps: { type: "array", items: { type: "string" } },
          step: { type: "number" },
          status: { type: "string", enum: ["done", "failed", "skipped"] },
        },
        required: ["action"],
      },
      handler: async (_ctx, args) => {
        const action = String(args.action || "");
        const title = String(args.title || "Plan");
        const steps = Array.isArray(args.steps) ? args.steps : [];
        callLog.push(`plan:${action}:${title}:${steps.length}`);
        return {
          success: true,
          output: `Plan "${title}" ${action === "create" ? "created" : action}d with ${steps.length} steps`,
        };
      },
    });

    // todo tool
    registry.register({
      name: "todo",
      description: "Manage sub-tasks with add/done/list",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["add", "done", "list"] },
          items: { type: "array", items: { type: "string" } },
        },
        required: ["action"],
      },
      handler: async (_ctx, args) => {
        const action = String(args.action || "");
        const items = Array.isArray(args.items) ? args.items : [];
        callLog.push(`todo:${action}:${items.length}`);
        return { success: true, output: `${action} ${items.length} todos` };
      },
    });

    // mock bash tool — does NOT execute real commands
    registry.register({
      name: "bash",
      description: "Execute a shell command (mocked)",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          workdir: { type: "string" },
        },
        required: ["command"],
      },
      handler: async (_ctx, args) => {
        callLog.push(`bash:${args.command}`);
        return { success: true, output: `[mocked] ${args.command}` };
      },
    });

    const pluginMgr = makePluginManager();
    const hookLog: string[] = [];

    // plugin for session/think lifecycle
    pluginMgr.register({
      name: "lifecycle-tracker",
      onSessionStart: () => {
        hookLog.push("plugin:sessionStart");
      },
      onBeforeThink: () => {
        hookLog.push("plugin:beforeThink");
      },
      onSessionEnd: () => {
        hookLog.push("plugin:sessionEnd");
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
    const result = await agent.run(
      "Create a Vite + TypeScript + Tailwind CSS todo app. Simple and minimal.",
    );

    // ── Assertions ──
    expect(result.success).toBe(true);
    expect(result.text).toContain("Todo app");

    // plan was called with create action
    expect(callLog).toContain("plan:create:Vite Todo App:4");

    // todo was called with add action
    expect(callLog.some((e) => e.startsWith("todo:add"))).toBe(true);

    // write_file was called at least 3 times
    const writes = callLog.filter((e) => e.startsWith("write_file:"));
    expect(writes.length).toBeGreaterThanOrEqual(3);

    // bash was called
    expect(callLog.some((e) => e.startsWith("bash:"))).toBe(true);

    // files exist on disk
    expect(existsSync(join(tmpDir, "index.html"))).toBe(true);
    expect(existsSync(join(tmpDir, "src", "main.ts"))).toBe(true);
    expect(existsSync(join(tmpDir, "src", "style.css"))).toBe(true);

    // verify file contents
    const html = readFileSync(join(tmpDir, "index.html"), "utf-8");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Todo App");
    expect(html).toContain("/src/main.ts");

    const ts = readFileSync(join(tmpDir, "src", "main.ts"), "utf-8");
    expect(ts).toContain("Todo");
    expect(ts).toContain("interface");

    const css = readFileSync(join(tmpDir, "src", "style.css"), "utf-8");
    expect(css).toContain("@tailwind base");

    // plugin lifecycle hooks fired
    expect(hookLog).toContain("plugin:sessionStart");
    expect(hookLog.filter((h) => h === "plugin:beforeThink").length).toBeGreaterThanOrEqual(1);

    // multi-turn: LLM was called multiple times
    expect((llmProvider.chat as any).mock.calls.length).toBeGreaterThanOrEqual(4);

    // result has context info
    expect(result.contextUsed).toBeDefined();
    expect(result.contextLimit).toBeDefined();
    expect(result.iterationCount).toBeGreaterThanOrEqual(4);

    agent.shutdown();
    expect(hookLog).toContain("plugin:sessionEnd");
  }, 30000);

  // ── Path isolation: write_file outside baseDir is rejected ────────────────

  it("rejects write_file outside baseDir (path isolation)", async () => {
    const config = makeConfig({ maxToolIterations: 3 });
    const outsideDir = join(tmpdir(), "outside");

    const llmProvider = makeLLMProvider(async function* () {
      yield toolCallChunk(
        "write_file",
        { path: "../outside/evil.txt", content: "bad" },
        "wf-escape",
      );
      yield doneChunk("tool_calls");
    });

    const logger = quietLogger();
    const registry = makeToolRegistry();
    registry.register({
      name: "write_file",
      description: "Write file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      handler: async (ctx, args) => {
        const { join: j } = await import("path");
        const path = String(args.path);
        const resolved = j(ctx.baseDir, path);
        if (!resolved.startsWith(ctx.baseDir))
          return { success: false, output: `Path not allowed: ${path}` };
        return { success: true, output: "ok" };
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
    // This will loop because LLM keeps returning tool_calls; maxToolIterations will hit
    const result = await agent.run("write evil file");

    expect(result.success).toBe(false);
    expect(result.error).toContain("iterations");
    agent.shutdown();
  }, 15000);

  // ── Plugin error isolation ─────────────────────────────────────────────────

  it("isolates crashing plugins — good plugins still run", async () => {
    const config = makeConfig({ maxToolIterations: 3 });

    const llmProvider = makeLLMProvider(async function* (messages, _tools) {
      if (messages.some((m) => m.role === "tool")) {
        yield textChunk("Got result, continuing");
        yield doneChunk("stop");
      } else {
        yield toolCallChunk("test_tool", {}, "tt-1");
        yield doneChunk("tool_calls");
      }
    });

    const logger = quietLogger();
    const registry = makeToolRegistry();
    registry.register({
      name: "test_tool",
      description: "Test tool",
      parameters: {},
      handler: async () => ({ success: true, output: "ok" }),
    });

    const pluginMgr = makePluginManager();
    const goodLog: string[] = [];

    pluginMgr.register({
      name: "crashing-plugin",
      onBeforeThink: () => {
        throw new Error("BOOM from plugin");
      },
    });
    pluginMgr.register({
      name: "good-plugin",
      onBeforeThink: () => {
        goodLog.push("good-ran");
      },
      onAfterTool: async () => {
        goodLog.push("after-tool");
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
    const result = await agent.run("test plugin isolation");

    expect(result.success).toBe(true);
    expect(goodLog).toContain("good-ran");
    expect(goodLog).toContain("after-tool");
    agent.shutdown();
  }, 15000);

  // ── Session manager integration ───────────────────────────────────────────

  it("persists tool calls and responses to session history", async () => {
    const config = makeConfig({
      maxToolIterations: 3,
      session: { autoSave: true, maxSessions: 50, isolateMemory: false },
    });

    const llmProvider = makeLLMProvider(async function* (messages, _tools) {
      if (messages.some((m) => m.role === "tool")) {
        yield textChunk("Done with the session tool execution");
        yield doneChunk("stop");
      } else {
        yield toolCallChunk("session_tool", { value: 42 }, "st-1");
        yield doneChunk("tool_calls");
      }
    });

    const logger = quietLogger();
    const registry = makeToolRegistry();
    registry.register({
      name: "session_tool",
      description: "Tool for session test",
      parameters: {},
      handler: async () => ({ success: true, output: "session result" }),
    });

    const pluginMgr = makePluginManager();
    const ctxMgr = makeContextManager();

    const sessionDir = join(tmpDir, "sessions");
    const sessionStore = new SessionStore(sessionDir);
    sessionStore.init();
    const sessionManager = new SessionManager(sessionStore, {
      model: "test-model",
      contextWindow: 32768,
      projectDir: tmpDir,
      maxSessions: 50,
    });

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
      sessionManager,
    };

    const agent = new Agent(deps);
    await agent.run("session persistence test");

    const history = sessionManager.loadHistory();
    expect(history.length).toBeGreaterThan(0);

    const roles = history.map((m) => m.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    expect(roles).toContain("tool");

    agent.shutdown();
  }, 15000);

  // ── Context clear / session switch ────────────────────────────────────────

  it("clearContext resets messages and systemPromptAdded flag", async () => {
    const config = makeConfig({ maxToolIterations: 3 });

    const llmProvider = makeLLMProvider(async function* () {
      yield textChunk("first response");
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
    const r1 = await agent.run("hello");
    expect(r1.success).toBe(true);
    const countBefore = ctxMgr.getMessageCount();

    agent.clearContext();
    const countAfter = ctxMgr.getMessageCount();
    expect(countAfter).toBeLessThan(countBefore);

    // Second run should re-add system prompt and work fresh
    const llmProvider2 = makeLLMProvider(async function* () {
      yield textChunk("second response");
      yield doneChunk("stop");
    });
    deps.llmProvider = llmProvider2 as any;

    const r2 = await agent.run("hello again");
    expect(r2.success).toBe(true);

    agent.shutdown();
  }, 15000);

  // ── setContext restores session history ────────────────────────────────────

  it("setContext loads history messages into context", async () => {
    const config = makeConfig({ maxToolIterations: 3 });

    let firstCall = true;
    const llmProvider = makeLLMProvider(async function* () {
      if (firstCall) {
        firstCall = false;
        yield textChunk("response in session");
        yield doneChunk("stop");
      } else {
        yield textChunk("response after resume");
        yield doneChunk("stop");
      }
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
    await agent.run("first message");

    // Simulate saving history
    sessionManager.appendMessage({
      role: "assistant",
      content: "response in session",
      timestamp: new Date().toISOString(),
    });
    const history = sessionManager.loadHistory();
    expect(history.length).toBeGreaterThan(0);

    // Reset context and load history
    agent.clearContext();
    agent.setContext(history);

    // System prompt re-added, history loaded, next run skips system prompt
    expect(ctxMgr.getMessageCount()).toBeGreaterThan(0);

    // Second call should work with restored context
    const llmProvider2 = makeLLMProvider(async function* () {
      yield textChunk("response after resume");
      yield doneChunk("stop");
    });
    deps.llmProvider = llmProvider2 as any;

    const result = await agent.run("continue from history");
    expect(result.success).toBe(true);
    expect(result.text).toBe("response after resume");

    agent.shutdown();
  }, 15000);

  // ── setContext filters out old system messages from history ───────────────

  it("setContext filters system messages from loaded history", async () => {
    const config = makeConfig({ maxToolIterations: 2 });
    const llmProvider = makeLLMProvider(async function* () {
      yield textChunk("ok, operation completed successfully");
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

    const history = [
      { role: "system", content: "OLD SYSTEM PROMPT" },
      { role: "user", content: "old user message" },
      { role: "assistant", content: "old assistant reply" },
    ];

    agent.setContext(history);
    const msgs = ctxMgr.getActiveHistory();

    // Only one system message (freshly built), no OLD SYSTEM PROMPT
    const systemMsgs = msgs.filter((m) => m.role === "system");
    expect(systemMsgs).toHaveLength(1);
    expect(systemMsgs[0].content).not.toContain("OLD SYSTEM PROMPT");

    // User and assistant messages are present
    expect(msgs.some((m) => m.role === "user" && m.content === "old user message")).toBe(true);
    expect(msgs.some((m) => m.role === "assistant" && m.content === "old assistant reply")).toBe(
      true,
    );

    agent.shutdown();
  }, 15000);

  // ── Hallucination detection in todo app context ───────────────────────────

  it("passes hallucination check for normal build output", async () => {
    const config = makeConfig({ maxToolIterations: 2 });
    const llmProvider = makeLLMProvider(async function* () {
      yield textChunk("Todo app built successfully. Run npm run dev.");
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
    const result = await agent.run("status check");
    expect(result.success).toBe(true);
    expect(result.text.length).toBeGreaterThan(0);
    agent.shutdown();
  }, 15000);

  // ── Max iterations stops stuck loops ──────────────────────────────────────

  it("stops when model loops on tool calls beyond max iterations", async () => {
    const config = makeConfig({ maxToolIterations: 3 });
    const llmProvider = makeLLMProvider(async function* () {
      yield toolCallChunk("loop_tool", {}, "loop-1");
      yield doneChunk("tool_calls");
    });
    const logger = quietLogger();
    const registry = makeToolRegistry();
    registry.register({
      name: "loop_tool",
      description: "Always loops",
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
    const result = await agent.run("infinite loop test");
    expect(result.success).toBe(false);
    expect(result.error).toContain("iterations");
    expect(result.iterationCount).toBe(3);
    agent.shutdown();
  }, 15000);
});
