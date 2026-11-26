// AQC-3: деградированная проверка не пропускает ответ, если в плане есть
// незакрытые шаги. Для чат-шагов fail-open сохраняется.
import { describe, it, expect, vi } from "vitest";
import { CriticGate } from "../../../src/core/agent/critic-gate";
import { createLoopState } from "../../../src/core/agent/loop-state";

function deps(overrides: Record<string, unknown> = {}) {
  const state = createLoopState();
  state.mutationsSinceCritic = 3;
  return {
    state,
    iteration: 5,
    logger: { warn: vi.fn(), info: vi.fn(), diagnostic: vi.fn() } as never,
    contextManager: { addMessage: vi.fn() } as never,
    slog: { logCritic: vi.fn(), logDiagnosticEvent: vi.fn() } as never,
    task: "fix filters",
    beforeFinish: true,
    toolEvents: [{ tool: "write_file", args: { path: "a" }, ok: true }],
    ...overrides,
  } as never;
}

function gate() {
  return new CriticGate({
    enabled: true,
    maxCalls: 4,
    maxRepairCycles: 1,
    verify: async () => null,
    buildPack: (d: never) => d,
  });
}

describe("AQC-3: degraded critic", () => {
  it("возвращает degraded при незакрытом шаге плана", async () => {
    expect(await gate().evaluate(deps({ planPendingSteps: ["step 1: filters"] }))).toBe(
      "degraded",
    );
  });

  it("оставляет pass для чат-шага без плана", async () => {
    expect(await gate().evaluate(deps())).toBe("pass");
  });
});
