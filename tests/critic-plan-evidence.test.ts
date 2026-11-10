import { describe, it, expect, afterEach } from "vitest";
import { buildEvidencePack } from "../src/modules/critic/evidence";
import { renderPack } from "../src/modules/critic/client-render";
import { CRITIC_SYSTEM_PROMPT } from "../src/modules/critic/client";
import { ExecutionModule } from "../src/modules/execution/module";
import { cleanupTestModule, createTestModule } from "./plan-test-utils";

/**
 * S5 (спека 0.25.2): критик получал `planSummary` одной строкой («N/M готово»)
 * и не видел списка незакрытых шагов — поэтому молчал (fail-open) на плане,
 * который агент не завершил. Теперь в пакете есть PLAN PENDING STEPS, а
 * промпт требует помечать незакрытую работу и не наказывать за недоступный тул.
 */

describe("critic plan evidence (S5)", () => {
  it("caps pending steps at 8 and renders '+N more'", () => {
    const pending = Array.from({ length: 11 }, (_, i) => `${i + 1}. step ${i + 1}`);
    const pack = buildEvidencePack({ task: "T", planPendingSteps: pending, toolEvents: [] });

    expect(pack.planPendingSteps?.length).toBe(8);
    expect(pack.planPendingStepsTotal).toBe(11);

    const text = renderPack(pack);
    expect(text).toContain("PLAN PENDING STEPS:");
    expect(text).toContain("1. step 1");
    expect(text).toContain("8. step 8");
    expect(text).toContain("(+3 more)");
  });

  it("renders no pending section when the plan is fully closed", () => {
    const pack = buildEvidencePack({ task: "T", planPendingSteps: [], toolEvents: [] });
    expect(renderPack(pack)).not.toContain("PLAN PENDING STEPS");
  });

  it("prompt requires flagging unclosed steps but sparing unavailable tools", () => {
    expect(CRITIC_SYSTEM_PROMPT).toContain("PLAN PENDING STEPS");
    expect(CRITIC_SYSTEM_PROMPT).toContain("shell unavailable");
    expect(CRITIC_SYSTEM_PROMPT).toContain("[SECURITY BLOCKED]");
  });
});

describe("ExecutionModule.getPlanPendingSteps (S5)", () => {
  let tmpDir: string;
  let execModule: ExecutionModule;

  afterEach(() => {
    if (tmpDir) cleanupTestModule(tmpDir);
  });

  it("reports an unconfirmed manual step as pending", async () => {
    ({ tmpDir, execModule } = createTestModule("mma-critic-pending-"));
    const tool = execModule.getToolDefinitions().find((t) => t.name === "plan")!;
    const res = await tool.handler({}, {
      action: "create",
      title: "T",
      steps: ["Update src/ui.tsx"],
      checks: ["manual:verify the UI"],
    });
    expect(res.success).toBe(true);

    // Модель закрыла шаг без наблюдения — isUnconfirmed обязан это поймать.
    execModule.getTracker()!.updateStepStatus(1, "done");

    const pending = execModule.getPlanPendingSteps();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toContain("Update src/ui.tsx");
  });

  it("a step with a manual note is not pending", async () => {
    ({ tmpDir, execModule } = createTestModule("mma-critic-pending-"));
    const tool = execModule.getToolDefinitions().find((t) => t.name === "plan")!;
    await tool.handler({}, {
      action: "create",
      title: "T",
      steps: ["Update src/ui.tsx"],
      checks: ["manual:verify the UI"],
    });
    execModule.getTracker()!.updateStepStatus(1, "done");
    execModule.getTracker()!.addNote(1, "page renders 6 cards");

    expect(execModule.getPlanPendingSteps()).toEqual([]);
  });
});
