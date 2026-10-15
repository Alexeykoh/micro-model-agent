/**
 * Live integration tests for P4 features: session auto-naming + in-loop critic.
 *
 * Run:
 *   $env:MMA_RUN_INTEGRATION=1
 *   bunx vitest run --config vitest.integration.config.ts tests/integration/p4-features.integration-test.ts
 *
 * Requires a real OpenAI-compatible backend (LM Studio default http://localhost:1234/v1)
 * with $MMA_MODEL (default qwen/qwen3.5-9b) loaded.
 */

import { describe, it, expect } from "vitest";
import { Agent } from "../../src/core/agent";
import { ToolRegistry } from "../../src/tools/registry";
import { ToolExecutor } from "../../src/tools/executor";
import { PluginManager } from "../../src/modules/plugins/manager";
import { ContextManager } from "../../src/core/context/manager";
import { HallucinationDetector } from "../../src/core/hallucination/detector";
import { SessionStore, SessionManager } from "../../src/modules/session/index";
import { OpenAICompatProvider } from "../../src/llm/openai-compat";
import {
  deriveSessionName,
  generateSessionTitle,
  type TitleChat,
} from "../../src/modules/session/auto-name";
import { CriticClient } from "../../src/modules/critic/client";
import { buildEvidencePack } from "../../src/modules/critic/evidence";
import { CriticGate } from "../../src/core/agent/critic-gate";
import { createLoopState } from "../../src/core/agent/loop-state";
import { DEFAULTS } from "../../src/config/defaults";
import type { AppConfig } from "../../src/config/types";
import type { AgentDeps } from "../../src/core/agent";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";

const BASE_URL = process.env.MMA_PROVIDER_BASEURL || "http://localhost:1234/v1";
const MODEL = process.env.MMA_MODEL || "qwen/qwen3.5-9b";
const API_KEY = process.env.MMA_PROVIDER_APIKEY || "not-needed";
const shouldSkip = process.env.MMA_RUN_INTEGRATION !== "1";

function liveProvider(): OpenAICompatProvider {
  return new OpenAICompatProvider({
    // opencode-go требует x-opencode-session; LM Studio лишний заголовок игнорирует.
    getSessionId: () => "integration-test",
    model: MODEL,
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    contextWindow: 32768,
  });
}

function quietLogger() {
  return {
    debug: () => {},
    diagnostic: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    setSessionDir: () => {},
    initSessionLog: () => {},
    closeSessionLog: () => {},
    logLLMRequest: () => {},
    logLLMResponse: () => {},
    logToolCall: () => {},
    logToolOutput: () => {},
  };
}

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const c = JSON.parse(JSON.stringify(DEFAULTS)) as AppConfig;
  c.model = MODEL;
  c.provider = { type: "openai-compat", baseUrl: BASE_URL, apiKey: API_KEY } as AppConfig["provider"];
  c.autoPlan = false;
  c.showReasoning = false;
  c.maxToolIterations = 15;
  c.session = { ...c.session, autoSave: true, autoName: true };
  c.critic = { enabled: true, maxCalls: 4, maxRepairCycles: 1, timeoutMs: 60000 };
  return Object.assign(c, overrides);
}

function chatOnce(provider: OpenAICompatProvider): TitleChat {
  return async (prompt, signal) => {
    let out = "";
    for await (const chunk of provider.chat([{ role: "user", content: prompt }], undefined, signal, {
      maxTokens: 48,
      reasoningEffort: "none",
    })) {
      if (chunk.type === "text" && chunk.content) out += chunk.content;
    }
    return out;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(shouldSkip)("P4 live: session auto-naming", () => {
  it("deterministic name is instant; live LLM returns a short title", async () => {
    const prompt = "Помоги мне спланировать поездку в Токио на выходные";
    expect(deriveSessionName(prompt)).toBe("Помоги мне спланировать поездку в Токио на выходные");

    const provider = liveProvider();
    const title = await generateSessionTitle(prompt, chatOnce(provider), 60000);
    expect(title).toBeTruthy();
    expect(title!.includes("\n")).toBe(false);
    expect(title!.length).toBeLessThanOrEqual(61);
    expect(title).not.toBe(deriveSessionName(prompt));
    // eslint-disable-next-line no-console
    process.stdout.write(`\n[live] deterministic="${deriveSessionName(prompt)}" llm="${title}"\n`);
  }, 120000);

  it("Agent.run names the session and the background LLM replaces the deterministic name", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "mma-p4-autoname-"));
    try {
      const config = makeConfig();
      const llmProvider = liveProvider();
      const logger = quietLogger();
      const registry = new ToolRegistry();
      const pluginMgr = new PluginManager();
      const ctxMgr = new ContextManager(32768);
      const executor = new ToolExecutor(
        registry,
        { config, baseDir: tmpDir, logger } as never,
        pluginMgr,
      );
      const sessionStore = new SessionStore(join(tmpDir, "sessions"));
      sessionStore.init();
      const sessionManager = new SessionManager(sessionStore, {
        model: MODEL,
        contextWindow: 32768,
        projectDir: tmpDir,
        maxSessions: 50,
      });
      const agent = new Agent({
        config,
        llmProvider,
        toolExecutor: executor,
        pluginManager: pluginMgr,
        contextManager: ctxMgr,
        hallucinationDetector: new HallucinationDetector(),
        logger,
        baseDir: tmpDir,
        promptBlocks: [],
        sessionManager,
      } as unknown as AgentDeps);

      const prompt = "Напиши короткое дружелюбное приветствие для нового сотрудника";
      const result = await agent.run(prompt);
      expect(result.success).toBe(true);

      const baseline = deriveSessionName(prompt);
      let meta = sessionManager.getActiveMeta()!;
      expect(meta.nameSource).toBe("auto");
      for (let i = 0; i < 40 && meta.name === baseline; i++) {
        await sleep(500);
        meta = sessionManager.getActiveMeta()!;
      }
      // eslint-disable-next-line no-console
      process.stdout.write(`\n[live] session name="${meta.name}" source=${meta.nameSource}\n`);
      expect(meta.name).not.toBe(baseline);
      expect(meta.name).not.toMatch(/^Session \d{4}-\d{2}-\d{2}$/);
      agent.shutdown();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 240000);

  it("never overwrites a manual session name", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "mma-p4-manual-"));
    try {
      const config = makeConfig();
      const llmProvider = liveProvider();
      const logger = quietLogger();
      const registry = new ToolRegistry();
      const pluginMgr = new PluginManager();
      const ctxMgr = new ContextManager(32768);
      const executor = new ToolExecutor(
        registry,
        { config, baseDir: tmpDir, logger } as never,
        pluginMgr,
      );
      const sessionStore = new SessionStore(join(tmpDir, "sessions"));
      sessionStore.init();
      const sessionManager = new SessionManager(sessionStore, {
        model: MODEL,
        contextWindow: 32768,
        projectDir: tmpDir,
        maxSessions: 50,
      });
      const manual = sessionManager.create("MANUAL P4 NAME");
      const agent = new Agent({
        config,
        llmProvider,
        toolExecutor: executor,
        pluginManager: pluginMgr,
        contextManager: ctxMgr,
        hallucinationDetector: new HallucinationDetector(),
        logger,
        baseDir: tmpDir,
        promptBlocks: [],
        sessionManager,
      } as unknown as AgentDeps);

      await agent.run("Скажи ровно слово: готово");
      const meta = sessionManager.get(manual.id)!;
      expect(meta.name).toBe("MANUAL P4 NAME");
      expect(meta.nameSource).toBe("manual");
      agent.shutdown();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 180000);
});

describe.skipIf(shouldSkip)("P4 live: in-loop critic", () => {
  it("live critic flags a broken evidence pack and accepts a clean one", async () => {
    const client = new CriticClient({ provider: liveProvider(), timeoutMs: 90000 });

    const broken = buildEvidencePack({
      task: "Create result.txt containing exactly the text HELLO, then verify by running `bun test`.",
      planSummary: "step 1: write result.txt (claimed done) | step 2: run tests (claimed done)",
      toolEvents: [
        { tool: "write_file", args: { path: "result.txt", content: "goodbye" }, ok: true },
        { tool: "bash", args: { command: "bun test" }, ok: false },
      ],
    });
    const brokenVerdict = await client.verify(broken);
    expect(brokenVerdict).not.toBeNull();
    // eslint-disable-next-line no-console
    process.stdout.write(
      `\n[live] broken verdict=${brokenVerdict!.status} issues=${brokenVerdict!.issues.length} summary="${brokenVerdict!.summary}"\n`,
    );
    expect(brokenVerdict!.status).not.toBe("ok");
    expect(brokenVerdict!.issues.length).toBeGreaterThan(0);

    const clean = buildEvidencePack({
      task: "Create greeting.txt containing the text hello.",
      toolEvents: [
        { tool: "write_file", args: { path: "greeting.txt", content: "hello" }, ok: true },
        { tool: "bash", args: { command: "type greeting.txt" }, ok: true },
      ],
    });
    const cleanVerdict = await client.verify(clean);
    expect(cleanVerdict).not.toBeNull();
    // eslint-disable-next-line no-console
    process.stdout.write(`\n[live] clean verdict=${cleanVerdict!.status} summary="${cleanVerdict!.summary}"\n`);
    expect(cleanVerdict!.status).not.toBe("critical");
  }, 240000);

  it("live gate triggers on mutations and injects a repair directive", async () => {
    const client = new CriticClient({ provider: liveProvider(), timeoutMs: 90000 });
    const state = createLoopState();
    state.mutationsSinceCritic = 5;
    const injected: string[] = [];
    const events: string[] = [];
    const gate = new CriticGate({
      enabled: true,
      maxCalls: 4,
      maxRepairCycles: 1,
      verify: (pack, signal) => client.verify(pack, signal),
      buildPack: (d) =>
        buildEvidencePack({ task: d.task, planSummary: d.planSummary, toolEvents: d.toolEvents }),
    });
    const action = await gate.evaluate({
      state,
      iteration: 4,
      logger: quietLogger() as never,
      contextManager: { addMessage: (m: { content: string }) => injected.push(String(m.content)) } as never,
      slog: { logCritic: (e: string) => events.push(e), logDiagnosticEvent: () => {} } as never,
      task: "Create result.txt containing exactly the text HELLO, then verify by running `bun test`.",
      toolEvents: [
        { tool: "write_file", args: { path: "result.txt", content: "goodbye" }, ok: true },
        { tool: "bash", args: { command: "bun test" }, ok: false },
      ],
      beforeFinish: true,
    });
    expect(events).toContain("critic_check");
    expect(action).toBe("retry");
    expect(injected.join("\n")).toContain("<system-summary>");
    // eslint-disable-next-line no-console
    process.stdout.write(`\n[live] gate action=${action} events=${events.join(",")}\n`);
    // eslint-disable-next-line no-console
    process.stdout.write(`[live] injected: ${injected.join(" | ").slice(0, 400)}\n`);
  }, 240000);

  it("Agent.run invokes the critic during a mutating run (session.jsonl evidence)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "mma-p4-critic-"));
    try {
      const config = makeConfig();
      const llmProvider = liveProvider();
      const logger = quietLogger();
      const registry = new ToolRegistry();
      registry.register({
        name: "write_file",
        description: "Write text content to a file at the given path.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path" },
            content: { type: "string", description: "File content" },
          },
          required: ["path", "content"],
        },
        handler: async (_ctx, args: Record<string, unknown>) => ({
          success: true,
          output: `Wrote ${String(args.path)} (${String(args.content).length} chars)`,
        }),
      });
      const pluginMgr = new PluginManager();
      const ctxMgr = new ContextManager(32768);
      const executor = new ToolExecutor(
        registry,
        { config, baseDir: tmpDir, logger } as never,
        pluginMgr,
      );
      const sessionStore = new SessionStore(join(tmpDir, "sessions"));
      sessionStore.init();
      const sessionManager = new SessionManager(sessionStore, {
        model: MODEL,
        contextWindow: 32768,
        projectDir: tmpDir,
        maxSessions: 50,
      });
      const agent = new Agent({
        config,
        llmProvider,
        toolExecutor: executor,
        pluginManager: pluginMgr,
        contextManager: ctxMgr,
        hallucinationDetector: new HallucinationDetector(),
        logger,
        baseDir: tmpDir,
        promptBlocks: [],
        sessionManager,
      } as unknown as AgentDeps);

      const result = await agent.run(
        "Use the write_file tool to create the file out.txt with the content 'hi'. Then reply with one short sentence.",
      );
      expect(result.success).toBe(true);

      const id = sessionManager.getActive()!;
      const log = sessionManager.loadSessionLog(id);
      const checks = log.filter((e) => e.type === "critic_check");
      const verdicts = log.filter((e) => e.type === "critic_verdict");
      // eslint-disable-next-line no-console
      process.stdout.write(
        `\n[live] session=${id} critic_check=${checks.length} critic_verdict=${verdicts.length} iterations=${result.iterationCount}\n`,
      );
      expect(checks.length).toBeGreaterThan(0);
      agent.shutdown();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 300000);
});
