import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ExecutionModule } from "../src/modules/execution/module";
import { createTestModule, cleanupTestModule, createTestPlan, writeTestFile } from "./plan-test-utils";

describe("execution step-gate deferral", () => {
  let tmpDir: string;
  let execModule: ExecutionModule;

  beforeEach(() => {
    ({ tmpDir, execModule } = createTestModule("mma-pending-"));
  });

  afterEach(() => cleanupTestModule(tmpDir));

  it("defers auto-advance to pendingMessages, not the live context", async () => {
    await createTestPlan(execModule, "T", ["Create src/a.ts"]);
    writeTestFile(tmpDir, "src/a.ts", "export const a = 1;\n");

    const plugin = execModule.getPlugin();
    const addMessage = vi.fn();
    const ctx: any = {
      contextManager: { addMessage },
      sessionLog: { plan: vi.fn() },
      logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    };

    await plugin.onAfterTool!(
      ctx,
      { name: "write_file", arguments: { path: "src/a.ts" } },
      { success: true, output: "Записан src/a.ts" },
    );

    // P0: во время tool-loop контекст не трогаем — иначе user-сообщение
    // вклинится между assistant(tool_calls) и tool-результатом.
    expect(addMessage).not.toHaveBeenCalled();

    // Сообщение уходит при следующем THINK, уже после tool-результатов.
    plugin.onBeforeThink!(ctx);
    expect(addMessage).toHaveBeenCalledTimes(1);
    expect(String(addMessage.mock.calls[0][0].content)).toContain("<system-summary>");
  });
});
