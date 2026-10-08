// Общие фистуры для тестов MoE-пути (`runWithMoE`): очередь планов/вердиктов,
// фейковый оркестратор, конструкторы плана и результатов, базовые deps.
//
// Вынесено из `moe-observability`/`moe-replan`/`moe-indicator`: три файла
// склеились в три одинаковых блока, а правило тестов — одна правда на общую
// фистуру, иначе фикстурный дрейф между копиями.
import type { AppConfig } from "../../src/config/types";
import { DEFAULTS } from "../../src/config/defaults";
import type { MoEOrchestratorLike } from "../../src/core/agent-moe";
import type {
  MoEPlan,
  PlanResult,
  SubtaskResult,
} from "../../src/modules/execution/types";

/** Очереди фейкового оркестратора: что отдать на `plan` / `verifyAndMerge`. */
export interface MoeScript {
  planQueue: Array<{ plan?: MoEPlan; raw?: string; error?: string }>;
  verifyQueue: unknown[];
  /** `isEnabled()` оркестратора (false → тест фолбэка на single-agent). */
  enabled?: boolean;
}

/** Пустой сценарий; чистится в `beforeEach` через `resetMoE`. */
export function makeMoEScript(): MoeScript {
  return { planQueue: [], verifyQueue: [], enabled: true };
}

export function resetMoE(script: MoeScript): void {
  script.planQueue.length = 0;
  script.verifyQueue.length = 0;
  script.enabled = true;
}

/** Оркестратор, отдающий заскриптованные планы и вердикты по очереди. */
export function fakeOrchestrator(script: MoeScript): MoEOrchestratorLike {
  return {
    isEnabled: () => script.enabled !== false,
    async plan() {
      const next = script.planQueue.shift();
      if (!next) return { error: "no plan scripted" };
      return next as never;
    },
    async verifyAndMerge() {
      const next = script.verifyQueue.shift();
      if (!next) throw new Error("no verify result scripted");
      return next as never;
    },
  };
}

export function makeMoEConfig(overrides?: {
  verbose?: boolean;
  maxReplanCycles?: number;
}): AppConfig {
  const config = JSON.parse(JSON.stringify(DEFAULTS)) as AppConfig;
  config.moe.enabled = true;
  if (overrides?.verbose !== undefined) config.ui.verbose = overrides.verbose;
  if (overrides?.maxReplanCycles !== undefined) {
    config.moe.maxReplanCycles = overrides.maxReplanCycles;
  }
  return config;
}

export function subtask(id: string): MoEPlan["subtasks"][number] {
  return {
    id,
    description: `do ${id}`,
    expert_tag: "code",
    allowed_files: [],
    read_only_files: [],
    depends_on: [],
    input_from: [],
    expected_output: "",
    success_criteria: [],
  };
}

export function planOf(...ids: string[]): MoEPlan {
  return {
    title: "test plan",
    subtasks: ids.map(subtask),
    shared_context: { rules: [], refs: [] },
  };
}

export function okResult(id: string): SubtaskResult {
  return {
    subtaskId: id,
    success: true,
    summary: `ok ${id}`,
    result: `${id} output`,
    durationMs: 1,
  };
}

/** Исполнитель, который «делает» все сабтаски успешно. */
export function okExecutor(): {
  executePlan(p: MoEPlan): Promise<PlanResult>;
  getUsageByTag(): undefined;
} {
  return {
    async executePlan(p: MoEPlan): Promise<PlanResult> {
      return {
        success: true,
        results: p.subtasks.map((s) => okResult(s.id)),
        errors: [],
        warnings: [],
      };
    },
    getUsageByTag: () => undefined,
  };
}

/** Базовые deps `runWithMoE` с фейковым оркестратором и верификатором. */
export function moeDeps(config: AppConfig, script: MoeScript): Record<string, unknown> {
  return {
    config,
    llmProvider: {},
    toolExecutor: { getRegistry: () => ({ getAll: () => [] }) },
    logger: { debug: () => {}, warn: () => {}, info: () => {} },
    baseDir: "/tmp/moe-fixture-test",
    orchestratorOverride: fakeOrchestrator(script),
    verifierOverride: {
      async verifyMoEManifest() {
        return { success: true, errors: [], warnings: [] };
      },
    },
  };
}

/** Фолбэк на single-agent: успешный путь не должен его трогать. */
export const singleAgentFallback = async () => ({
  success: false,
  text: "fallback",
  iterationCount: 0,
});
