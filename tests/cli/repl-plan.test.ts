import { describe, it, expect } from "vitest";
import { Repl } from "../../src/cli/repl";
import { ExecutionModule } from "../../src/modules/execution/module";
import { makeCaptureChannel } from "./capture-channel";

function makeRepl(execModule?: ExecutionModule): Repl {
  const { channel } = makeCaptureChannel();
  return new Repl(
    { shutdown: () => {}, run: async () => ({}) } as any,
    { ui: {} } as any,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    execModule,
    undefined,
    channel,
  );
}

function fakeRenderer() {
  const printed: string[][] = [];
  return { printed, planBlock: (lines: string[]) => void printed.push(lines) };
}

const PLAN = {
  id: "p1",
  title: "Test plan",
  steps: [{ id: 1, description: "create a.ts", status: "pending" as const }],
  createdAt: new Date().toISOString(),
};

describe("Repl plan rendering", () => {
  it("prints the checklist from the execution module on plan events", () => {
    const execModule = {
      getActivePlan: () => PLAN,
    } as unknown as ExecutionModule;
    const repl = makeRepl(execModule);
    const renderer = fakeRenderer();
    (repl as any).renderPlan(renderer);
    expect(renderer.printed).toHaveLength(1);
    expect(renderer.printed[0].join("\n")).toContain("Test plan");
  });

  it("prints nothing when no plan is active", () => {
    const execModule = { getActivePlan: () => null } as unknown as ExecutionModule;
    const repl = makeRepl(execModule);
    const renderer = fakeRenderer();
    (repl as any).renderPlan(renderer);
    expect(renderer.printed).toHaveLength(0);
  });

  it("degrades without an execution module (tests / legacy wiring)", () => {
    const repl = makeRepl(undefined);
    const renderer = fakeRenderer();
    (repl as any).renderPlan(renderer);
    expect(renderer.printed).toHaveLength(0);
  });
});
