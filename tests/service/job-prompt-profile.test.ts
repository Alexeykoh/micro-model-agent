/**
 * Гварды S-04: job-задача сервиса не платит за полный харнесс.
 *
 * До правки `mode: job` получал системный промпт REPL/web (директивы, карта
 * проекта, скиллы) плюс определения всех тулов: односложный запрос стоил
 * ~20 000 prompt-токенов. Тест фиксирует контракт: промпт < 300 токенов,
 * 0 тулов без `toolAllowlist`, allowlist сужает набор, после хода всё
 * восстанавливается.
 */
import { describe, expect, it } from "vitest";
import { Agent, type AgentDeps } from "../../src/core/agent";
import type { SessionRunner } from "../../src/core/bootstrap/session-runner";
import { estimateTokens } from "../../src/llm/token-counter";
import { buildServiceJobPrompt } from "../../src/core/system-prompt";
import { DEFAULTS } from "../../src/config/defaults";
import type { AppConfig } from "../../src/config/types";
import type { PluginManager, ToolContext } from "../../src/tools/types";
import { ToolRegistry } from "../../src/tools/registry";
import { ToolExecutor } from "../../src/tools/executor";
import type { ServiceForwarder } from "../../src/modules/service/runtime/event-bridge";
import type { TaskRecord } from "../../src/modules/service/runtime/task-registry";
import { applyTaskScope, runTask } from "../../src/modules/service/runtime/run-task";

/** Порог промпта service-job (INV-SJ2); полный оставлял ~20K токенов. */
const LEAN_PROMPT_MAX_TOKENS = 300;
/** Сколько тулов «полного набора» эмулируем — чтобы утечка была заметной. */
const FULL_TOOL_COUNT = 120;

/** Конфиг из дефолтов (Agent читает provider/model/reasoning). */
function config(): AppConfig {
  return structuredClone(DEFAULTS);
}

/** Реестр из N тулов с длинными описаниями (как настоящий полный набор). */
function registry(count = FULL_TOOL_COUNT): ToolRegistry {
  const reg = new ToolRegistry();
  for (let i = 0; i < count; i++) {
    reg.register(
      {
        name: `tool_${i}`,
        description: `Tool number ${i} does something. `.repeat(12),
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Path argument for the tool" } },
        },
        security: { caps: [] },
        handler: async () => ({ success: true, output: "" }),
      },
      "test",
    );
  }
  reg.register(
    {
      name: "read_file",
      description: "Read a file from disk.",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      security: { caps: [{ fs: "read" }], pathArgs: ["path"] },
      handler: async () => ({ success: true, output: "" }),
    },
    "test",
  );
  return reg;
}

/** Исполнитель с заданным allowlist (он же enforcement для job). */
function executor(toolAllowlist?: string[]): ToolExecutor {
  const ctx = {
    config: config(),
    baseDir: "/tmp",
    logger: { warn() {}, info() {}, debug() {} },
    toolAllowlist,
  } as unknown as ToolContext;
  return new ToolExecutor(registry(), ctx, {} as PluginManager);
}

/** Агент на минимальных депах: промпт собирается без запуска хода. */
function agent(exec: ToolExecutor): Agent {
  const deps = {
    config: config(),
    llmProvider: { countTokens: (text: string) => estimateTokens(text) },
    toolExecutor: exec,
    pluginManager: {} as PluginManager,
    contextManager: {},
    hallucinationDetector: {},
    logger: {},
    baseDir: "/tmp",
    toolTags: [],
    promptBlocks: [
      {
        source: "core",
        label: "harness-directives",
        content: "FULL HARNESS DIRECTIVE ".repeat(400),
        priority: "high",
        essential: true,
        estimatedTokens: 2000,
      },
    ],
  } as unknown as AgentDeps;
  return new Agent(deps);
}

/** Раннер-заглушка: только то, что читает `applyTaskScope`/`runTask`. */
function runner(exec: ToolExecutor, allowlist?: string[]) {
  const agentValue = {
    promptProfile: "full" as "full" | "service-job",
    async run() {
      return { success: true, text: "ок", iterationCount: 1 };
    },
  };
  const value = {
    toolCtx: { toolAllowlist: allowlist },
    execModule: { getActivePlan: () => null },
    sessionManager: {
      appendLog: () => {},
      getActiveMeta: () => undefined,
    },
    agent: agentValue,
  };
  return {
    value: value as unknown as SessionRunner,
    seen: {
      profile: () => agentValue.promptProfile,
      allowlist: () => value.toolCtx.toolAllowlist,
    },
  };
}

/** Форвардер-заглушка: runTask зовёт методы событий, нам они не важны. */
function forwarder(): ServiceForwarder {
  return {
    onText() {},
    onToolStart() {},
    onToolEnd() {},
    onPhase() {},
    onReasoning() {},
    hold() {},
    release() {},
    discard() {},
    flush() {},
    setAttempt() {},
  } as unknown as ServiceForwarder;
}

function task(patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    jobId: "job_test",
    sessionId: "ses_test",
    mode: "job",
    status: "running",
    input: "Ответь одним словом: ок",
    createdAt: new Date().toISOString(),
    events: [],
    waiters: [],
    ...patch,
  };
}

describe("S-04: service-job prompt profile", () => {
  it("buildServiceJobPrompt stays under the documented token threshold", () => {
    const prompt = buildServiceJobPrompt("test-model", []);
    const tokens = estimateTokens(prompt);
    expect(tokens).toBeLessThan(LEAN_PROMPT_MAX_TOKENS);
    // Честность: промпт не притворяется, что тулы есть.
    expect(prompt).toContain("No tools are available");
    expect(prompt).not.toContain("TOOLS: file ops");
  });

  it("Agent service-job ignores harness blocks and sends 0 tool definitions", () => {
    const exec = executor([]);
    const a = agent(exec);
    a.promptProfile = "service-job";

    const info = a.getSystemPromptInfo();
    expect(info.tokenCount).toBeLessThan(LEAN_PROMPT_MAX_TOKENS);
    expect(info.text).not.toContain("FULL HARNESS DIRECTIVE");
    expect(info.blocks.map((b) => b.label)).toEqual(["service-job"]);

    // Возврат к full — прежний промпт (профиль не «залипает»).
    a.promptProfile = "full";
    const full = a.getSystemPromptInfo();
    expect(full.text).toContain("FULL HARNESS DIRECTIVE");
    expect(full.tokenCount).toBeGreaterThan(LEAN_PROMPT_MAX_TOKENS);
  });

  it("job without toolAllowlist exposes zero tools; with one — exactly that tool", () => {
    const exec = executor([]);
    expect(exec.getToolDefinitions().length).toBe(0);

    const r = runner(exec, ["bash"]);
    const restore = applyTaskScope(r.value, task());
    expect(r.seen.allowlist()).toEqual([]);
    expect(r.seen.profile()).toBe("service-job");
    restore();
    expect(r.seen.allowlist()).toEqual(["bash"]);
    expect(r.seen.profile()).toBe("full");

    const allowed = runner(exec, ["bash"]);
    const restoreAllowed = applyTaskScope(
      allowed.value,
      task({ toolAllowlist: ["read_file"] }),
    );
    expect(allowed.seen.allowlist()).toEqual(["read_file"]);
    // Тот же исполнитель с allowlist из одного имени отдаёт ровно один тул.
    const one = executor(["read_file"]);
    expect(one.getToolDefinitions().map((t) => t.name)).toEqual(["read_file"]);
    restoreAllowed();
  });

  it("runTask applies the job scope for the turn and restores it (INV-SJ3)", async () => {
    const exec = executor([]);
    const r = runner(exec, ["bash"]);
    let duringAllow: string[] | undefined;
    let duringProfile: string | undefined;
    (r.value.agent as unknown as { run: () => Promise<unknown> }).run = async () => {
      duringAllow = r.value.toolCtx.toolAllowlist;
      duringProfile = r.seen.profile();
      return { success: true, text: "ок", iterationCount: 1 };
    };

    const result = await runTask({ runner: r.value, task: task(), forwarder: forwarder() });
    expect(result.success).toBe(true);
    expect(duringAllow).toEqual([]);
    expect(duringProfile).toBe("service-job");
    expect(r.seen.allowlist()).toEqual(["bash"]);
    expect(r.seen.profile()).toBe("full");
  });

  it("interactive mode keeps the full profile and its tools", () => {
    const exec = executor();
    const r = runner(exec, undefined);
    const restore = applyTaskScope(r.value, task({ mode: "interactive" }));
    expect(r.seen.profile()).toBe("full");
    expect(r.seen.allowlist()).toBeUndefined();
    expect(exec.getToolDefinitions().length).toBe(FULL_TOOL_COUNT + 1);
    restore();
  });
});
