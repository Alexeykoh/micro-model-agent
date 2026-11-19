// Guard: декларативное evidence из аргументов тула plan доходит до шага и
// сохраняется при re-plan (спека 2026-11-19).
import { describe, it, expect } from "vitest";
import { PlanCreator } from "../../src/modules/execution/planner";
import { createPlanToolDefinitions } from "../../src/modules/execution/plan-tool";
import type { PlanToolDeps } from "../../src/modules/execution/plan-tool";

describe("evidence в контракте тула plan", () => {
  it("createPlan сохраняет evidence по шагам", () => {
    const plan = PlanCreator.createPlan(
      "Движение",
      ["Шаг A", "Шаг B"],
      "/workspace",
      [],
      ["command:bun test", "file-exists:src/a.ts"],
      [],
      ["behavioral", "static"],
    );
    expect(plan.steps[0]!.evidence).toBe("behavioral");
    expect(plan.steps[1]!.evidence).toBe("static");
  });

  it("re-plan сохраняет поле у новых шагов", () => {
    const plan = PlanCreator.createPlan(
      "Движение",
      ["Шаг A"],
      "/workspace",
      [],
      ["command:bun test"],
      [],
      ["behavioral"],
    );
    // replan сохраняет только завершённые шаги — помечаем первый как done.
    plan.steps[0]!.status = "done";
    const replanned = PlanCreator.replan(plan, ["Шаг B"], undefined, ["file-exists:src/b.ts"], [], ["behavioral"]);
    expect(replanned.steps).toHaveLength(2);
    expect(replanned.steps[0]!.evidence).toBe("behavioral");
    expect(replanned.steps[1]!.evidence).toBe("behavioral");
  });

  it("схема тула объявляет параметр evidence", () => {
    const defs = createPlanToolDefinitions({} as PlanToolDeps);
    const plan = defs.find((d) => d.name === "plan");
    expect(plan).toBeTruthy();
    const props = (plan!.parameters as { properties: Record<string, unknown> }).properties;
    expect(props.evidence).toBeTruthy();
  });
});
