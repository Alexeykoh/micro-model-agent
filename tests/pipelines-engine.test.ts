import { describe, it, expect, } from "vitest";
import { PipelineEngine } from "../src/modules/pipelines/engine";
import type { PipelineStep } from "../src/modules/pipelines/parser";

describe("PipelineEngine", () => {
  it("should resolve dependency order", () => {
    const steps: PipelineStep[] = [
      { id: "research", agent: "explore", prompt: "research" },
      { id: "implement", agent: "code", prompt: "implement", depends_on: ["research"] },
      { id: "verify", agent: "verify", prompt: "verify", depends_on: ["implement"] },
    ];
    const engine = new PipelineEngine();
    const order = engine.resolveDependencies(steps);
    expect(order).toEqual(["research", "implement", "verify"]);
  });

  it("should detect cycles", () => {
    const steps: PipelineStep[] = [
      { id: "a", agent: "x", prompt: "a", depends_on: ["b"] },
      { id: "b", agent: "x", prompt: "b", depends_on: ["a"] },
    ];
    const engine = new PipelineEngine();
    expect(() => engine.resolveDependencies(steps)).toThrow();
  });

  it("should identify parallel-ready steps", () => {
    const steps: PipelineStep[] = [
      { id: "plan", agent: "x", prompt: "plan" },
      { id: "web", agent: "x", prompt: "web", depends_on: ["plan"], parallel: true },
      { id: "api", agent: "x", prompt: "api", depends_on: ["plan"], parallel: true },
    ];
    const engine = new PipelineEngine();
    const ready = engine.getReadySteps(steps, new Set(["plan"]));
    expect(ready).toHaveLength(2);
  });

  it("should track step status", () => {
    const engine = new PipelineEngine();
    engine.setStepStatus("a", "running");
    expect(engine.getStepStatus("a")).toBe("running");
    engine.setStepStatus("a", "done");
    expect(engine.isComplete(["a", "b"])).toBe(false);
  });
});
