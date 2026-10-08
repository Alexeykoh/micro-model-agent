// Per-session планы: слоты PlanStore + switchSession/forgetSession ExecutionModule.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PlanStore } from "../src/modules/execution/plan-store";
import { PlanCreator } from "../src/modules/execution/planner";
import { ExecutionModule } from "../src/modules/execution/module";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dirname, "_test_session_plans");

function mkPlan(title: string, steps: string[]) {
  return PlanCreator.createPlan(title, steps, TEST_DIR);
}

describe("PlanStore session slots", () => {
  let store: PlanStore;
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    store = new PlanStore(TEST_DIR);
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("изолирует слоты сессий", () => {
    const a = mkPlan("Plan A", ["a1"]);
    const b = mkPlan("Plan B", ["b1", "b2"]);
    store.saveSessionActive("ses_a", a);
    store.saveSessionActive("ses_b", b);
    expect(store.loadSessionActive("ses_a")!.title).toContain("Plan A");
    expect(store.loadSessionActive("ses_b")!.steps).toHaveLength(2);
  });

  it("возвращает null для новой сессии и не трогает глобальный план", () => {
    store.saveActive(mkPlan("Global", ["g"]));
    expect(store.loadSessionActive("ses_new")).toBeNull();
    expect(store.loadActive()!.title).toContain("Global");
  });

  it("clearSessionActive чистит только свой слот и терпит отсутствие", () => {
    store.saveSessionActive("ses_a", mkPlan("Plan A", ["a1"]));
    store.saveSessionActive("ses_b", mkPlan("Plan B", ["b1"]));
    expect(() => store.clearSessionActive("ses_ghost")).not.toThrow();
    store.clearSessionActive("ses_a");
    expect(store.loadSessionActive("ses_a")).toBeNull();
    expect(store.loadSessionActive("ses_b")!.title).toContain("Plan B");
  });

  it("отклоняет sessionId с сепараторами пути", () => {
    expect(() => store.saveSessionActive("../evil", mkPlan("X", ["x"]))).toThrow();
    expect(() => store.loadSessionActive("a/b")).toThrow();
  });
});

describe("ExecutionModule.switchSession", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("переключает план между сессиями и помнит обе", () => {
    const mod = new ExecutionModule(TEST_DIR);
    mod.switchSession("ses_a");
    mod.setPlan(mkPlan("Plan A", ["a1", "a2"]));
    expect(mod.getActivePlan()!.title).toContain("Plan A");

    mod.switchSession("ses_b");
    expect(mod.getActivePlan()).toBeNull();

    mod.setPlan(mkPlan("Plan B", ["b1"]));
    mod.switchSession("ses_a");
    expect(mod.getActivePlan()!.title).toContain("Plan A");
    mod.switchSession("ses_b");
    expect(mod.getActivePlan()!.title).toContain("Plan B");
  });

  it("усыновляет стартовый трекер в первую сессию (миграция legacy)", () => {
    const mod = new ExecutionModule(TEST_DIR);
    mod.setPlan(mkPlan("Legacy", ["l1"]));
    mod.switchSession("ses_first");
    expect(mod.getActivePlan()!.title).toContain("Legacy");
    // Вторая сессия чужой план не наследует.
    mod.switchSession("ses_second");
    expect(mod.getActivePlan()).toBeNull();
  });

  it("не воскрешает отменённый план возвратом в сессию", () => {
    const mod = new ExecutionModule(TEST_DIR);
    mod.switchSession("ses_a");
    mod.setPlan(mkPlan("Plan A", ["a1"]));
    // Эмулируем `plan abort`: трекер чистится через общий сеттер.
    (mod as unknown as { trackerRef: { current: null } }).trackerRef.current = null;
    mod.switchSession("ses_b");
    mod.switchSession("ses_a");
    expect(mod.getActivePlan()).toBeNull();
  });

  it("forgetSession чистит слот и сбрасывает трекер текущей", () => {
    const mod = new ExecutionModule(TEST_DIR);
    mod.switchSession("ses_a");
    mod.setPlan(mkPlan("Plan A", ["a1"]));
    mod.switchSession("ses_b");
    mod.forgetSession("ses_a");
    mod.switchSession("ses_a");
    expect(mod.getActivePlan()).toBeNull();

    mod.setPlan(mkPlan("Plan A2", ["a1"]));
    mod.forgetSession("ses_a");
    expect(mod.getActivePlan()).toBeNull();
  });

  it("switchSession(null) сбрасывает трекер", () => {
    const mod = new ExecutionModule(TEST_DIR);
    mod.switchSession("ses_a");
    mod.setPlan(mkPlan("Plan A", ["a1"]));
    mod.switchSession(null);
    expect(mod.getActivePlan()).toBeNull();
  });

  it("не стирает чужой живой слот при переключении без своего трекера", () => {
    // Общий web-модуль (наблюдатель) усыновил сессию, когда плана ещё не было:
    // трекер null, sessionId = ses_a. Раньше его `switchSession(ses_b)` чистил
    // слот ses_a, хотя план принадлежал per-session раннеру (репорт: план не
    // появлялся в сайдбаре после переключения/создания сессии).
    const observer = new ExecutionModule(TEST_DIR);
    observer.switchSession("ses_a");

    const owner = new ExecutionModule(TEST_DIR);
    owner.switchSession("ses_a");
    owner.setPlan(mkPlan("Plan A", ["a1", "a2"]));

    observer.switchSession("ses_b");

    const slot = observer.getStore().loadSessionActive("ses_a");
    expect(slot).not.toBeNull();
    expect(slot!.title).toContain("Plan A");
  });

  it("plan_step персистит мутацию и в per-session слот", async () => {
    const mod = new ExecutionModule(TEST_DIR);
    mod.switchSession("ses_a");
    mod.setPlan(mkPlan("Plan A", ["first generic step", "second generic step"]));
    const stepTool = mod.getToolDefinitions().find((t) => t.name === "plan_step")!;
    const res = await stepTool.handler({} as never, { step: 1, status: "done" });
    expect(res.success).toBe(true);
    // Глобальный active.json и слот сессии должны сойтись: прямой saveActive
    // раньше слот не трогал, и после reload сайдбар показывал старые статусы.
    const slot = mod.getStore().loadSessionActive("ses_a")!;
    expect(slot.steps[0].status).toBe("done");
    expect(slot.steps[1].status).toBe("pending");
  });
});
