/**
 * Фабрика per-session раннеров: изоляция параллельных ходов.
 *
 * Проверяет wiring (не поведение агента): запиненный менеджер, свой контекст
 * с историей из стора, свои exec-тулы/трекер, свой set_thinking, scoped
 * shutdown. Тяжёлые части (LLM, MCP, LSP) — стабы/пустышки, файловый стор —
 * во временной директории.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/modules/session/store";
import { SessionManager } from "../src/modules/session/manager";
import { ToolRegistry } from "../src/tools/registry";
import { PluginManager } from "../src/modules/plugins/manager";
import { ModuleRegistry } from "../src/modules/registry";
import { MemoryStore } from "../src/modules/memory/store";
import {
  createSessionRunnerFactory,
  type SessionRunnerTemplate,
} from "../src/core/bootstrap/session-runner";

function silentLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    diagnostic: () => {},
  } as never;
}

function testConfig() {
  return {
    model: "test-model",
    contextWindow: 8000,
    contextBudget: { systemPrompt: 0.1, responseReserve: 0.15 },
    provider: { type: "openai-compat" },
    // reasoning задан — фабрика обязана зарегистрировать СВОЙ set_thinking.
    reasoning: { mode: "medium" },
  } as never;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "mma-runner-"));
  const baseDir = mkdtempSync(join(tmpdir(), "mma-ws-"));
  const store = new SessionStore(join(dir, "sessions"));
  store.init();
  const sessionManager = new SessionManager(store, {
    model: "test-model",
    contextWindow: 8000,
    projectDir: baseDir,
  });
  const meta = sessionManager.create("runner-test");
  const template = {
    config: testConfig(),
    configRef: { current: testConfig() },
    llmProvider: {} as never,
    providerManager: { activeName: "test" } as never,
    logger: silentLogger(),
    baseDir,
    configDir: dir,
    promptBlocks: [],
    envReport: {},
    lazyPromptBlocks: () => Promise.resolve([]),
    memoryStore: new MemoryStore(join(dir, "memory")),
    moduleRegistry: new ModuleRegistry(),
    reasoningProbePromise: Promise.resolve(false),
    reasoningStrategy: "none",
    contextProbePromise: Promise.resolve(null),
    toolRegistry: new ToolRegistry(),
    pluginManager: new PluginManager(),
    sessionManager,
    skillsModule: { getSystemPromptBlock: () => null },
    indexerModule: { getSystemPromptBlock: () => null },
    activeToolTags: [],
    capabilitiesProbeRef: {},
    contextLogEnabled: false,
  } as unknown as SessionRunnerTemplate;
  return { dir, baseDir, store, sessionManager, meta, template };
}

describe("session runner factory", () => {
  it("spawns an isolated runner pinned to its session", () => {
    const { sessionManager, meta, template } = setup();
    const spawn = createSessionRunnerFactory(template);
    const runner = spawn(meta.id);

    // Запиненный менеджер: своя сессия активна, общая не тронута.
    expect(runner.sessionManager.getActive()).toBe(meta.id);
    expect(runner.sessionManager.getActiveMeta()?.id).toBe(meta.id);
    expect(sessionManager.getActive()).toBe(meta.id);
    expect(runner.toolCtx.sessionId).toBe(meta.id);

    // Свой контекст (не shared): у новой сессии история пуста — системный
    // промпт встанет на первом ходе (как у main-агента до первого run()).
    expect(runner.contextManager.getActiveHistory()).toHaveLength(0);

    // Exec-тулы — свои (не main-трекера): все 4 на месте.
    for (const name of ["plan", "plan_step", "todo", "verify"]) {
      expect(runner.registry.has(name)).toBe(true);
    }
    // set_thinking — свой (main-версия пропущена при клоне, своя дорегистрирована).
    expect(runner.registry.has("set_thinking")).toBe(true);

    // Исполнитель и трекер — свои инстансы.
    expect(runner.toolExecutor).toBeDefined();
    expect(runner.execModule).toBeDefined();
    expect(runner.execModule.getActivePlan()).toBeNull();

    // Scoped shutdown не бросает без процессов.
    expect(() => runner.agent.shutdown(meta.id)).not.toThrow();
  });

  it("seeds a returning session from store history", () => {
    const { sessionManager, meta, template } = setup();
    sessionManager.appendMessage({
      role: "user",
      content: "remembered task",
      timestamp: new Date().toISOString(),
    });
    const spawn = createSessionRunnerFactory(template);
    const runner = spawn(meta.id);

    const history = runner.contextManager.getActiveHistory();
    const texts = history.map((m) => JSON.stringify(m.content));
    expect(texts.some((t) => t.includes("remembered task"))).toBe(true);
  });

  it("two runners do not share context or plan tracker", () => {
    const { sessionManager, template } = setup();
    const a = sessionManager.create("A");
    // Параллелят живые сессии; create() больше не удаляет чужие пустые.
    sessionManager.appendMessage({
      role: "user",
      content: "task-a",
      timestamp: new Date().toISOString(),
    });
    const b = sessionManager.create("B");
    const spawn = createSessionRunnerFactory(template);
    const ra = spawn(a.id);
    const rb = spawn(b.id);

    expect(ra.contextManager).not.toBe(rb.contextManager);
    expect(ra.sessionManager).not.toBe(rb.sessionManager);
    expect(ra.toolExecutor).not.toBe(rb.toolExecutor);
    expect(ra.execModule).not.toBe(rb.execModule);
    expect(ra.agent).not.toBe(rb.agent);
    expect(ra.toolCtx.sessionId).toBe(a.id);
    expect(rb.toolCtx.sessionId).toBe(b.id);

    ra.contextManager.addMessage({ role: "user", content: "only-a" });
    const bTexts = rb.contextManager.getActiveHistory().map((m) => JSON.stringify(m.content));
    expect(bTexts.some((t) => t.includes("only-a"))).toBe(false);
  });

  it("forkPinned rejects unknown sessions and never creates", () => {
    const { sessionManager, template } = setup();
    expect(() => sessionManager.forkPinned("ses_nope")).toThrow();
    expect(sessionManager.list().length).toBe(1);
    expect(() => createSessionRunnerFactory(template)("ses_nope")).toThrow();
  });

  it("registry clone carries shared tools without touching the original", () => {
    const { template } = setup();
    const tool = {
      name: "dummy_probe",
      description: "probe",
      parameters: { type: "object", properties: {} },
      handler: () => Promise.resolve({ success: true, output: "ok" }),
    };
    template.toolRegistry.register(tool);
    const spawn = createSessionRunnerFactory(template);
    const runner = spawn(template.sessionManager.create("x").id);
    expect(runner.registry.has("dummy_probe")).toBe(true);
  });
});
