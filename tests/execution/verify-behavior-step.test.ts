// Guard: UI-шаг не подтверждается только сборкой (W1 спеки turn-runtime-gate).
//
// Волна 21: «добавь поиск в каталог» + `command: bun run build` → шаг accepted,
// хотя страница падала в рантайме. Теперь такой шаг требует поведенческого
// доказательства (`command:` с тестами/запуском, `http:` или `manual:`).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestModule, cleanupTestModule } from "../plan-test-utils";
import type { ExecutionModule } from "../../src/modules/execution/module";
import { t } from "../../src/i18n/index";

describe("done-гейт: поведенческий шаг", () => {
  let tmpDir: string;
  let execModule: ExecutionModule;

  beforeEach(() => {
    ({ tmpDir, execModule } = createTestModule("mma-behavior-gate-"));
  });

  afterEach(() => cleanupTestModule(tmpDir));

  function planTool() {
    return execModule.getToolDefinitions().find((t2) => t2.name === "plan")!;
  }

  async function createPlan(step: string, check: string) {
    const res = await planTool().handler({}, {
      action: "create",
      title: "T",
      steps: [step],
      checks: [check],
    });
    expect(res.success, String(res.output)).toBe(true);
  }

  it("UI-шаг с build-доказательством не закрывается", async () => {
    const step = "Добавь поиск в компонент каталога";
    const check = "command: bun run build";
    await createPlan(step, check);

    const res = await planTool().handler({}, { action: "update", step: 1, status: "done" });

    expect(res.success).toBe(false);
    expect(String(res.output)).toContain(t("plan.check_need_behavior", { step: "1", check }));
  });

  it("UI-шаг с тестами закрывается", async () => {
    await createPlan("Поправь стили карточки в компоненте", "command: bun test");

    const res = await planTool().handler({}, { action: "update", step: 1, status: "done" });

    expect(res.success, String(res.output)).toBe(true);
  });

  it("не-UI шаг по-прежнему закрывается сборкой", async () => {
    await createPlan("Обнови CHANGELOG под новый релиз", "command: bun run build");

    const res = await planTool().handler({}, { action: "update", step: 1, status: "done" });

    expect(res.success, String(res.output)).toBe(true);
  });

  it("UI-шаг с http-проверкой: успех и отказ (инъекция fetch)", async () => {
    const { checkDoneEvidence, parseCheck } = await import(
      "../../src/modules/execution/plan-checks"
    );
    const target = { description: "Сделай страницу каталога", check: "http://x" };

    const ok = await checkDoneEvidence(
      parseCheck("http:http://x/~Каталог")!,
      target,
      1,
      { fetchImpl: (async () => new Response("<h2>Каталог</h2>")) as typeof fetch },
    );
    expect(ok?.blocked).toBeNull();
    expect(String(ok?.note)).toContain("HTTP 200");

    const bad = await checkDoneEvidence(
      parseCheck("http:http://x/")!,
      target,
      1,
      { fetchImpl: (async () => new Response("nope", { status: 500 })) as typeof fetch },
    );
    expect(bad?.blocked?.success).toBe(false);
    expect(String(bad?.blocked?.output)).toContain("http");
  });
});
