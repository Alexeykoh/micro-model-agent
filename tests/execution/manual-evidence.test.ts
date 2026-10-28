// Guard: `manual:`-проверка без наблюдения не подтверждает шаг (W2 спеки
// turn-runtime-gate).
//
// Волна 21: шаг «проверил глазами» закрывался без единой записи о том, ЧТО
// проверили, и финальный аудит считал пункт выполненным. Теперь `done` с
// `manual:` требует note, наблюдение уходит в журнал сессии событием
// `verify_evidence`, а аудит считает такой шаг незакрытым.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestModule, cleanupTestModule } from "../plan-test-utils";
import type { ExecutionModule } from "../../src/modules/execution/module";
import { isUnconfirmed } from "../../src/modules/execution/final-audit";
import { t } from "../../src/i18n/index";

describe("manual-проверка: наблюдение обязательно", () => {
  let tmpDir: string;
  let execModule: ExecutionModule;

  beforeEach(() => {
    ({ tmpDir, execModule } = createTestModule("mma-manual-evidence-"));
  });

  afterEach(() => cleanupTestModule(tmpDir));

  function planTool() {
    return execModule.getToolDefinitions().find((t2) => t2.name === "plan")!;
  }

  async function createManualPlan() {
    const res = await planTool().handler({}, {
      action: "create",
      title: "T",
      steps: ["Открой страницу каталога и проверь карточки"],
      checks: ["manual:видны 6 карточек и поиск работает"],
    });
    expect(res.success, String(res.output)).toBe(true);
  }

  it("done без note блокируется", async () => {
    await createManualPlan();

    const res = await planTool().handler({}, { action: "update", step: 1, status: "done" });

    expect(res.success).toBe(false);
    expect(String(res.output)).toContain(
      t("plan.manual_needs_note", {
        step: "1",
        check: "manual:видны 6 карточек и поиск работает",
      }),
    );
  });

  it("done с note проходит и пишет verify_evidence в журнал", async () => {
    await createManualPlan();
    const directive = { calls: [] as unknown[][] };
    const ctx: any = {
      sessionLog: {
        plan: () => {},
        directive: (...args: unknown[]) => directive.calls.push(args),
      },
    };

    const res = await planTool().handler(ctx, {
      action: "update",
      step: 1,
      status: "done",
      note: "открыл /, видны 6 карточек, поиск «город» → 1",
    });

    expect(res.success, String(res.output)).toBe(true);
    const evidence = directive.calls.find((c) => c[0] === "verify_evidence");
    expect(evidence).toBeTruthy();
    expect(String(evidence![1])).toContain("6 карточек");
  });

  it("аудит считает manual-шаг без note незакрытым", () => {
    expect(isUnconfirmed({ status: "done", description: "Открой страницу", check: "manual:x", note: "" } as never)).toBe(true);
    expect(isUnconfirmed({ status: "done", description: "Открой страницу", check: "manual:x", note: "видел" } as never)).toBe(false);
    expect(isUnconfirmed({ status: "done", check: "file-exists:src/a.ts", note: "" } as never)).toBe(
      false,
    );
    expect(isUnconfirmed({ status: "failed", description: "Открой страницу", check: "manual:x", note: "видел" } as never)).toBe(true);
  });
});
