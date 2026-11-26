// Общий бюджет хода: мягкий предел выводится из maxToolIterations, а не хардкодится.
import { describe, it, expect } from "vitest";
import { ToolBatchExecutor } from "../../src/core/agent/tool-batch";
import { createLoopState } from "../../src/core/agent/loop-state";
import {
  effectiveSoftToolBudget,
  softBudgetDue,
} from "../../src/core/agent/tool-batch-budget";
import { makeToolBatchDeps } from "../helpers/tool-batch-deps";

const batch = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: String(i),
    name: "read_file",
    arguments: { path: `f${i}.txt` },
  }));

describe("мягкий бюджет масштабируется с лимитом хода", () => {
  it("дефолтный конфиг 200 итераций даёт 150 вызовов вместо 16", () => {
    expect(effectiveSoftToolBudget(200)).toBe(150);
    expect(effectiveSoftToolBudget(20)).toBe(16); // нижняя граница
    expect(effectiveSoftToolBudget(10)).toBe(16); // не превышает hard cap
    expect(effectiveSoftToolBudget(0)).toBe(16); // невалидный конфиг
  });

  it("не форсирует финал на 16-м вызове при лимите 200", async () => {
    const state = createLoopState(effectiveSoftToolBudget(200));
    const ex = new ToolBatchExecutor(
      makeToolBatchDeps({ execute: async () => ({ success: true, output: "ok" }) }),
    );
    const mid = await ex.execute(state, batch(16), new Set(), "work", "", "task");
    expect(mid.finalize).toBeUndefined();
    expect(softBudgetDue(state)).toBe(false);

    const rest = await ex.execute(state, batch(134), new Set(), "work", "", "task");
    expect(state.toolCallsThisTurn).toBe(150);
    expect(rest.finalize).toBe("soft_tool_budget");
  });

  it("сохраняет старое поведение при дефолтном состоянии", async () => {
    const state = createLoopState();
    expect(state.softToolBudget).toBe(16);
    const ex = new ToolBatchExecutor(
      makeToolBatchDeps({ execute: async () => ({ success: true, output: "ok" }) }),
    );
    const res = await ex.execute(state, batch(16), new Set(), "work", "", "task");
    expect(res.finalize).toBe("soft_tool_budget");
  });
});
