import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DEFAULTS } from "../../../src/config/defaults";
import type { MoEPlan } from "../../../src/modules/execution/types";
import { topologicalSort, MoEExecutor } from "../../../src/modules/execution/moe-executor";
import { ToolRegistry } from "../../../src/tools/registry";
import type { ToolDefinition, } from "../../../src/tools/types";
import { mkdtempSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("MoEExecutor topologicalSort", () => {
  it("sorts simple dependency chain", () => {
    const subtasks = [
      {
        id: "a",
        description: "",
        expert_tag: "code",
        allowed_files: [],
        read_only_files: [],
        depends_on: [],
        input_from: [],
        expected_output: "",
        success_criteria: [],
      },
      {
        id: "b",
        description: "",
        expert_tag: "code",
        allowed_files: [],
        read_only_files: [],
        depends_on: ["a"],
        input_from: [],
        expected_output: "",
        success_criteria: [],
      },
    ];
    const waves = topologicalSort(subtasks);
    expect(waves).toHaveLength(2);
    expect(waves[0].map((s) => s.id)).toEqual(["a"]);
    expect(waves[1].map((s) => s.id)).toEqual(["b"]);
  });

  it("puts independent tasks in same wave", () => {
    const subtasks = [
      {
        id: "a",
        description: "",
        expert_tag: "code",
        allowed_files: [],
        read_only_files: [],
        depends_on: [],
        input_from: [],
        expected_output: "",
        success_criteria: [],
      },
      {
        id: "b",
        description: "",
        expert_tag: "code",
        allowed_files: [],
        read_only_files: [],
        depends_on: [],
        input_from: [],
        expected_output: "",
        success_criteria: [],
      },
    ];
    const waves = topologicalSort(subtasks);
    expect(waves).toHaveLength(1);
    expect(waves[0].map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("handles diamond dependency", () => {
    const subtasks = [
      {
        id: "a",
        description: "",
        expert_tag: "code",
        allowed_files: [],
        read_only_files: [],
        depends_on: [],
        input_from: [],
        expected_output: "",
        success_criteria: [],
      },
      {
        id: "b",
        description: "",
        expert_tag: "code",
        allowed_files: [],
        read_only_files: [],
        depends_on: ["a"],
        input_from: [],
        expected_output: "",
        success_criteria: [],
      },
      {
        id: "c",
        description: "",
        expert_tag: "code",
        allowed_files: [],
        read_only_files: [],
        depends_on: ["a"],
        input_from: [],
        expected_output: "",
        success_criteria: [],
      },
      {
        id: "d",
        description: "",
        expert_tag: "code",
        allowed_files: [],
        read_only_files: [],
        depends_on: ["b", "c"],
        input_from: [],
        expected_output: "",
        success_criteria: [],
      },
    ];
    const waves = topologicalSort(subtasks);
    expect(waves).toHaveLength(3);
    expect(waves[0].map((s) => s.id)).toEqual(["a"]);
    expect(waves[1].map((s) => s.id).sort()).toEqual(["b", "c"]);
    expect(waves[2].map((s) => s.id)).toEqual(["d"]);
  });

  it("returns empty waves for cycle", () => {
    const subtasks = [
      {
        id: "a",
        description: "",
        expert_tag: "code",
        allowed_files: [],
        read_only_files: [],
        depends_on: ["b"],
        input_from: [],
        expected_output: "",
        success_criteria: [],
      },
      {
        id: "b",
        description: "",
        expert_tag: "code",
        allowed_files: [],
        read_only_files: [],
        depends_on: ["a"],
        input_from: [],
        expected_output: "",
        success_criteria: [],
      },
    ];
    const waves = topologicalSort(subtasks);
    expect(waves).toHaveLength(0);
  });

  it("has expert config for code tag", () => {
    const expert = DEFAULTS.experts.code;
    expect(expert).toBeDefined();
    expect(expert.tool_tags).toContain("file");
    expect(expert.max_attempts).toBe(3);
  });
});

describe("MoEExecutor executePlan", () => {
  let tmpDir: string;
  let registry: ToolRegistry;
  let mockToolExecutor: any;
  let subagentHandler: any;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-moe-"));
    registry = new ToolRegistry();
    subagentHandler = vi.fn().mockResolvedValue({ success: true, output: "done" });
    const mockSubagentTool: ToolDefinition = {
      name: "subagent",
      description: "Mock subagent",
      parameters: { type: "object", properties: {} },
      tags: ["code"],
      handler: subagentHandler,
    };
    registry.register(mockSubagentTool);
    mockToolExecutor = {
      execute: vi.fn(),
      getToolDefinitions: vi.fn().mockReturnValue([]),
      registry,
      // Each subtask forks an isolated executor; the mock returns itself.
      fork: vi.fn(() => mockToolExecutor),
    };
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  /** Базовые deps исполнителя; `extra` добавляет шов событий/сигнала. */
  function executorDeps(config: unknown): Record<string, unknown> {
    return {
      config,
      toolRegistry: registry,
      toolExecutor: mockToolExecutor,
      llmProvider: {},
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        logLLMRequest: vi.fn(),
        logLLMResponse: vi.fn(),
      },
      baseDir: tmpDir,
    };
  }

  /** Исполнитель с мок-логгером; `extra` добавляет шов событий/сигнала. */
  function makeExecutor(config: unknown, extra?: Record<string, unknown>) {
    return new MoEExecutor({
      ...executorDeps(config),
      ...extra,
    } as never);
  }

  /**
   * Мок-сабагент, который держит ход `delayMs` и считает пик конкурентности.
   * @returns функция, дающая достигнутый пик.
   */
  function trackConcurrency(delayMs: number): () => number {
    let active = 0;
    let peak = 0;
    subagentHandler.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, delayMs));
      active--;
      return { success: true, output: "ok" };
    });
    return () => peak;
  }

  /** Независимые подзадачи одной волны (для тестов параллелизма). */
  function wavePlan(...ids: string[]): MoEPlan {
    return {
      title: "Parallel wave",
      shared_context: { rules: [], refs: [] },
      subtasks: ids.map((id) => ({
        id,
        description: "independent",
        expert_tag: "code",
        allowed_files: [],
        read_only_files: [],
        depends_on: [],
        input_from: [],
        expected_output: "",
        success_criteria: [],
      })),
    };
  }

  function createPlan(): MoEPlan {
    return {
      title: "MoE Test Plan",
      subtasks: [
        {
          id: "task-1",
          description: "Write first file",
          expert_tag: "code",
          allowed_files: ["output1.txt"],
          read_only_files: [],
          depends_on: [],
          input_from: [],
          expected_output: "file written",
          success_criteria: ["output1.txt exists"],
        },
        {
          id: "task-2",
          description: "Write second file",
          expert_tag: "code",
          allowed_files: ["output2.txt"],
          read_only_files: [],
          depends_on: [],
          input_from: [],
          expected_output: "file written",
          success_criteria: ["output2.txt exists"],
        },
        {
          id: "task-3",
          description: "Read both files",
          expert_tag: "code",
          allowed_files: [],
          read_only_files: ["output1.txt", "output2.txt"],
          depends_on: ["task-1", "task-2"],
          input_from: ["task-1", "task-2"],
          expected_output: "files read",
          success_criteria: ["content returned"],
        },
      ],
      shared_context: { rules: [], refs: [] },
    };
  }

  it("executes independent subtasks in parallel and dependent after them", async () => {
    const executor = makeExecutor(DEFAULTS);

    const result = await executor.executePlan(createPlan());

    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(3);
    expect(result.results.every((r) => r.success)).toBe(true);
    expect(subagentHandler).toHaveBeenCalledTimes(3);
  });

  it("marks plan as failed when a subtask fails", async () => {
    let callCount = 0;
    subagentHandler.mockImplementation(async () => {
      callCount++;
      return { success: callCount !== 2, output: callCount === 2 ? "fail" : "ok" };
    });

    const executor = makeExecutor(DEFAULTS);

    const result = await executor.executePlan(createPlan());

    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.results.some((r) => !r.success)).toBe(true);
  });

  it("returns error when subtasks form a cycle", async () => {
    const cyclicPlan: MoEPlan = {
      title: "Cyclic",
      subtasks: [
        {
          id: "a",
          description: "",
          expert_tag: "code",
          allowed_files: [],
          read_only_files: [],
          depends_on: ["b"],
          input_from: [],
          expected_output: "",
          success_criteria: [],
        },
        {
          id: "b",
          description: "",
          expert_tag: "code",
          allowed_files: [],
          read_only_files: [],
          depends_on: ["a"],
          input_from: [],
          expected_output: "",
          success_criteria: [],
        },
      ],
      shared_context: { rules: [], refs: [] },
    };

    const executor = makeExecutor(DEFAULTS);

    const result = await executor.executePlan(cyclicPlan);
    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain("topologically sort");
  });

  it("passes tool_tags to subagent based on expert config", async () => {
    const executor = makeExecutor(DEFAULTS);

    await executor.executePlan(createPlan());

    const writeCall = subagentHandler.mock.calls.find((call: any) =>
      (call[1] as any).task?.includes("Write"),
    );
    expect(writeCall).toBeDefined();
    const args = writeCall![1] as any;
    expect(args.tool_tags).toEqual(DEFAULTS.experts.code.tool_tags);
  });

  it("passes scope to subagent", async () => {
    const executor = makeExecutor(DEFAULTS);

    await executor.executePlan(createPlan());

    const writeCall = subagentHandler.mock.calls.find((call: any) =>
      (call[1] as any).allowed_files?.includes("output1.txt"),
    );
    expect(writeCall).toBeDefined();
    const args = writeCall![1] as any;
    expect(args.allowed_files).toContain("output1.txt");
  });

  it("returns error when subagent tool is missing from registry", async () => {
    const emptyRegistry = new ToolRegistry();
    const executor = new MoEExecutor({
      ...executorDeps(DEFAULTS),
      toolRegistry: emptyRegistry,
      toolExecutor: { ...mockToolExecutor, registry: emptyRegistry },
    });

    const result = await executor.executePlan(createPlan());
    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain("Subagent tool not found");
  });

  it("caps concurrent subtasks per wave at maxParallelTasks", async () => {
    const peak = trackConcurrency(20);
    const config = {
      ...DEFAULTS,
      security: { ...DEFAULTS.security, rateLimits: { maxRequestsPerMinute: 60, maxParallelTasks: 2 } },
    } as never;

    const executor = makeExecutor(config);
    const result = await executor.executePlan(wavePlan(...Array.from({ length: 8 }, (_, i) => `task-${i}`)));

    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(8);
    expect(peak()).toBeLessThanOrEqual(2);
  });

  it("runs a wave serially on a local single-engine backend", async () => {
    // ses_muz7sg1l_0ankgu: LM Studio с одним движком роняет параллельные
    // запросы к одной модели ("Engine protocol startup was aborted").
    const peak = trackConcurrency(10);
    const config = {
      ...DEFAULTS,
      provider: { ...DEFAULTS.provider, type: "lmstudio", baseUrl: "http://localhost:1234/v1" },
      security: { ...DEFAULTS.security, rateLimits: { maxRequestsPerMinute: 60, maxParallelTasks: 5 } },
    } as never;

    const result = await makeExecutor(config).executePlan(wavePlan("a", "b", "c"));

    expect(result.success).toBe(true);
    expect(peak()).toBe(1);
  });

  it("puts the failure reason into the moe_subtask event", async () => {
    subagentHandler.mockResolvedValue({
      success: false,
      output: 'Failed to load model "qwen/qwen3.5-9b". Error: Engine protocol startup was aborted.',
    });

    const events: Array<Record<string, unknown>> = [];
    const config = {
      ...DEFAULTS,
      // Фейл инфраструктурный → транзиентный → эксперт ретраит с backoff.
      // Один attempt, чтобы тест не ждал реальные паузы.
      experts: { ...DEFAULTS.experts, code: { ...DEFAULTS.experts.code, max_attempts: 1 } },
    } as never;

    await makeExecutor(config, {
      onEvent: (e: { data: Record<string, unknown> }) => events.push(e.data),
    }).executePlan(createPlan());

    const failed = events.find((e) => e.status === "failed");
    expect(String(failed?.error)).toContain("Engine protocol startup was aborted");
    expect(failed?.infra).toBe(true);
  });
});
