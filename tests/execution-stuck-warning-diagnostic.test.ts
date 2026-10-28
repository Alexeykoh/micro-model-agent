// Guard: внутренняя диагностика петли не должна попадать в чат обычного
// режима. Застрявший шаг/серия упавших тулов — это счётчики харнесса, а не
// текст для пользователя (STYLE.md: quiet by default, подробности — в verbose).
//
// Регресс из стресс-теста (волна 21): в ленте висели жёлтые строки
// «⚠ Инструмент edit_file упал 3 раз. Попробуйте другой инструмент.» —
// они шли через `logger.warn` и форвардились в браузер без флага `diagnostic`.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync } from "fs";
import { ExecutionModule } from "../src/modules/execution/module";
import { createTestModule } from "./plan-test-utils";

describe("stuck-предупреждение — диагностика, не пользовательский текст", () => {
  let tmpDir: string;
  let mod: ExecutionModule;

  beforeEach(() => {
    tmpDir = createTestModule("mma-stuckwarn-diag-").tmpDir;
    mod = new ExecutionModule(tmpDir, 8);
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("идёт через logger.diagnostic и не дублируется в logger.warn", async () => {
    const planToolDef = mod.getToolDefinitions().find((t) => t.name === "plan")!;
    await planToolDef.handler({}, {
      action: "create",
      title: "T",
      steps: ["Create src/a.ts"],
      checks: ["file-exists:src/a.ts"],
    });

    const ctx = {
      contextManager: { addMessage: vi.fn() },
      sessionLog: { plan: vi.fn(), directive: vi.fn() },
      logger: { warn: vi.fn(), diagnostic: vi.fn(), debug: vi.fn() },
      iteration: 0,
    } as any;

    const plugin: any = mod.getPlugin();
    const bashFail: any = { id: "c1", name: "bash", arguments: { command: "bun run x" } };
    const failRes: any = { success: false, output: "Command failed with exit code 1" };
    for (let i = 1; i <= 3; i++) {
      ctx.iteration = i;
      await plugin.onAfterTool(ctx, bashFail, failRes);
      plugin.onBeforeThink(ctx);
    }

    // Порог застревания ExecutionModule(tmpDir, 8): предупреждение выходит
    // из `onBeforeThink` на 8-й итерации шага.
    for (let i = 4; i <= 8; i++) {
      ctx.iteration = i;
      plugin.onBeforeThink(ctx);
    }

    const diagnosticCalls = ctx.logger.diagnostic.mock.calls;
    expect(diagnosticCalls.length).toBeGreaterThan(0);
    expect(diagnosticCalls[0][0]).toBe("warn");
    expect(String(diagnosticCalls[0][1])).toMatch(/No progress|step|шаг/i);
    // Обычный warn в чат не уходит — иначе строка снова станет жёлтой в ленте.
    expect(ctx.logger.warn).not.toHaveBeenCalled();
    // Журнал сессии (для модели и разбора) сохраняется прежним.
    expect(ctx.sessionLog.directive).toHaveBeenCalledWith(
      "stuck-warning",
      expect.any(String),
      expect.anything(),
    );
  });
});
