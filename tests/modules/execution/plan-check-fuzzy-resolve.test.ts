import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { StepVerifier } from "../../../src/modules/execution/verifier";
import type { ExecutionModule } from "../../../src/modules/execution/module";
import {
  cleanupTestModule,
  createTestModule,
  writeTestFile,
} from "../../plan-test-utils";

/**
 * Дефект A (спека 0.25.2): existence-проверка резолвила «любой файл с тем же
 * basename», поэтому `file-exists:src/app/cart/page.tsx` подтверждался чужим
 * `src/app/about/page.tsx`, а auto-advance вообще не читал `step.check`.
 */

function mockCtx() {
  return { contextManager: { addMessage: () => {} }, sessionLog: { plan: () => {} } } as any;
}

function planTool(execModule: ExecutionModule) {
  return execModule.getToolDefinitions().find((t) => t.name === "plan")!;
}

describe("file-exists contract resolves only the declared path", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "mma-fuzzy-check-"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("does not accept another file with the same basename", async () => {
    mkdirSync(join(base, "src", "app", "other"), { recursive: true });
    writeFileSync(join(base, "src", "app", "other", "page.tsx"), "export const x = 1;\n");

    const verifier = new StepVerifier(base);
    const res = await verifier.checkFileExists("src/app/missing/page.tsx");
    expect(res.passed).toBe(false);
  });

  it("still passes for the exact declared path", async () => {
    mkdirSync(join(base, "src", "app", "cart"), { recursive: true });
    writeFileSync(join(base, "src", "app", "cart", "page.tsx"), "export const x = 1;\n");

    const verifier = new StepVerifier(base);
    const res = await verifier.checkFileExists("src/app/cart/page.tsx");
    expect(res.passed).toBe(true);
  });
});

describe("auto-advance respects the step check", () => {
  let tmpDir: string;
  let execModule: ExecutionModule;

  beforeEach(() => {
    ({ tmpDir, execModule } = createTestModule("mma-fuzzy-adv-"));
  });
  afterEach(() => {
    cleanupTestModule(tmpDir);
  });

  it("does not close a step whose file-exists check names a missing path", async () => {
    const res = await planTool(execModule).handler({}, {
      action: "create",
      title: "T",
      steps: ["Create src/app/page.tsx"],
      checks: ["file-exists:src/app/x/page.tsx"],
    });
    expect(res.success).toBe(true);

    // Описание резолвится и файл на месте — смягчённая проверка прошла бы.
    writeTestFile(tmpDir, "src/app/page.tsx");
    const plugin = execModule.getPlugin();
    plugin.onAfterTool!(mockCtx(), {
      name: "write_file",
      arguments: { path: "src/app/page.tsx" },
    } as any, { success: true, output: "ok" });

    expect(execModule.getTracker()!.getStep(1)!.status).not.toBe("done");
  });

  it("does not close a file-modified step whose target predates the plan", async () => {
    writeTestFile(tmpDir, "src/b.ts"); // старый файл — до плана
    // Отматываем mtime заметно дальше допуска `provablyStale` (2s).
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(tmpDir, "src", "b.ts"), past, past);
    const res = await planTool(execModule).handler({}, {
      action: "create",
      title: "T",
      // Проверка обязана относиться к файлам своего шага (дефект D): шаг называет
      // оба файла, свежий `src/a.ts` уводит vacuous-truth гард в false, а
      // старый `src/b.ts` блокирует автопродвижение через file-modified.
      steps: ["Update src/a.ts and src/b.ts"],
      checks: ["file-modified:src/b.ts"],
    });
    expect(res.success).toBe(true);

    // Свежий файл из описания: vacuous-truth гард не блокирует, блокирует check.
    writeTestFile(tmpDir, "src/a.ts");
    const plugin = execModule.getPlugin();
    plugin.onAfterTool!(mockCtx(), {
      name: "write_file",
      arguments: { path: "src/a.ts" },
    } as any, { success: true, output: "ok" });

    expect(execModule.getTracker()!.getStep(1)!.status).not.toBe("done");
  });

  it("closes the step when the file-exists check target is present", async () => {
    const res = await planTool(execModule).handler({}, {
      action: "create",
      title: "T",
      steps: ["Create src/a.ts"],
      checks: ["file-exists:src/a.ts"],
    });
    expect(res.success).toBe(true);

    writeTestFile(tmpDir, "src/a.ts");
    const plugin = execModule.getPlugin();
    plugin.onAfterTool!(mockCtx(), {
      name: "write_file",
      arguments: { path: "src/a.ts" },
    } as any, { success: true, output: "ok" });

    expect(execModule.getTracker()!.getStep(1)!.status).toBe("done");
  });
});
