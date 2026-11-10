import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setLocale } from "../../../src/i18n/index";
import { ExecutionModule } from "../../../src/modules/execution/module";
import { cleanupTestModule, createTestModule } from "../../plan-test-utils";

/**
 * Дефект D (спека 0.25.2): массив checks принимался как есть, сверялась только
 * длина. Сдвинутый массив привязывал проверку к чужому шагу (шаг получал
 * `manual:`-ловушку). Теперь файловая проверка обязана относиться к файлам
 * своего шага; непривязанная заменяется на self-certified manual + предупреждение.
 */

describe("plan checks bound to steps (D)", () => {
  let tmpDir: string;
  let execModule: ExecutionModule;

  beforeEach(() => {
    setLocale("en");
    ({ tmpDir, execModule } = createTestModule("mma-checks-binding-"));
  });
  afterEach(() => {
    cleanupTestModule(tmpDir);
  });

  function planTool() {
    return execModule.getToolDefinitions().find((t) => t.name === "plan")!;
  }

  it("drops a file check that names another step's file", async () => {
    const res = await planTool().handler({}, {
      action: "create",
      title: "T",
      steps: ["Create src/b.ts"],
      checks: ["file-exists:src/a.ts"],
    });
    expect(res.success).toBe(true);
    expect(res.output).toContain("does not match");
    expect(execModule.getTracker()!.getStep(1)!.check).toBe("manual:Create src/b.ts");
  });

  it("keeps a matching file check", async () => {
    const res = await planTool().handler({}, {
      action: "create",
      title: "T",
      steps: ["Create src/b.ts"],
      checks: ["file-exists:src/b.ts"],
    });
    expect(res.success).toBe(true);
    expect(res.output).not.toContain("does not match");
    expect(execModule.getTracker()!.getStep(1)!.check).toBe("file-exists:src/b.ts");
  });

  it("accepts a nested check path that shares the step's file", async () => {
    const res = await planTool().handler({}, {
      action: "create",
      title: "T",
      steps: ["Create src/b.ts"],
      checks: ["file-exists:bicycle-shop/src/b.ts"],
    });
    expect(res.success).toBe(true);
    expect(execModule.getTracker()!.getStep(1)!.check).toBe("file-exists:bicycle-shop/src/b.ts");
  });
});
