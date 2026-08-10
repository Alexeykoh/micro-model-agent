import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PlanStore } from "../src/modules/execution/plan-store";
import { PlanCreator } from "../src/modules/execution/planner";
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dirname, "_test_plan_store");

function mkPlan(title: string, steps: string[]) {
  return PlanCreator.createPlan(title, steps, TEST_DIR);
}

describe("PlanStore", () => {
  let store: PlanStore;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    store = new PlanStore(TEST_DIR);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("should save and load active plan", () => {
    const plan = mkPlan("Active Test", ["step A", "step B"]);
    store.saveActive(plan);
    const loaded = store.loadActive();
    expect(loaded).not.toBeNull();
    expect(loaded!.title).toContain("Active Test");
    expect(loaded!.steps).toHaveLength(2);
  });

  it("should return null when no active plan exists", () => {
    expect(store.loadActive()).toBeNull();
  });

  it("should clear active plan", () => {
    const plan = mkPlan("Clear Test", ["step A"]);
    store.saveActive(plan);
    store.clearActive();
    expect(store.loadActive()).toBeNull();
  });

  it("should save and load draft plans", () => {
    const plan = mkPlan("Draft Test", ["step X"]);
    store.saveDraft(plan);
    const loaded = store.loadDraft(plan.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.title).toContain("Draft Test");
  });

  it("should list drafts", () => {
    store.saveDraft(mkPlan("Draft 1", ["a"]));
    store.saveDraft(mkPlan("Draft 2", ["b"]));
    const drafts = store.listDrafts();
    expect(drafts).toHaveLength(2);
  });

  it("should remove draft", () => {
    const plan = mkPlan("To Remove", ["a"]);
    store.saveDraft(plan);
    store.removeDraft(plan.id);
    expect(store.loadDraft(plan.id)).toBeNull();
  });

  it("should archive plan and remove from active", () => {
    const plan = mkPlan("Archive Test", ["step A"]);
    store.saveActive(plan);
    store.archivePlan(plan);
    expect(store.loadActive()).toBeNull();
    const archived = store.listArchived();
    expect(archived).toHaveLength(1);
    expect(archived[0].title).toContain("Archive Test");
  });

  it("should archive plan and remove from drafts", () => {
    const plan = mkPlan("Archive Draft", ["step A"]);
    store.saveDraft(plan);
    store.archivePlan(plan);
    expect(store.loadDraft(plan.id)).toBeNull();
    expect(store.listArchived()).toHaveLength(1);
  });

  it("should list all plans with correct status", () => {
    const activePlan = mkPlan("Active", ["a"]);
    const draftPlan = mkPlan("Draft", ["b"]);
    const archivedPlan = mkPlan("Archived", ["c"]);
    store.saveActive(activePlan);
    store.saveDraft(draftPlan);
    store.archivePlan(archivedPlan);

    const all = store.listAll();
    expect(all).toHaveLength(3);
    const active = all.find((m) => m.status === "active");
    const draft = all.find((m) => m.status === "draft");
    const archived = all.find((m) => m.status === "archived");
    expect(active).toBeDefined();
    expect(draft).toBeDefined();
    expect(archived).toBeDefined();
    expect(active!.title).toContain("Active");
  });

  it("should find plan by id across locations", () => {
    const plan = mkPlan("Find Me", ["a"]);
    store.saveDraft(plan);
    const found = store.find(plan.id);
    expect(found).not.toBeNull();
    expect(found!.status).toBe("draft");
    expect(found!.plan.title).toContain("Find Me");
  });

  it("should find active plan by id", () => {
    const plan = mkPlan("Active Find", ["a"]);
    store.saveActive(plan);
    const found = store.find(plan.id);
    expect(found).not.toBeNull();
    expect(found!.status).toBe("active");
  });

  it("should find archived plan by id", () => {
    const plan = mkPlan("Archived Find", ["a"]);
    store.archivePlan(plan);
    const found = store.find(plan.id);
    expect(found).not.toBeNull();
    expect(found!.status).toBe("archived");
  });

  it("should return null when finding non-existent plan", () => {
    expect(store.find("plan_nonexistent")).toBeNull();
  });

  it("should migrate legacy plan.json on loadActive", () => {
    const legacyPath = join(TEST_DIR, ".mma", "plan.json");
    mkdirSync(join(TEST_DIR, ".mma"), { recursive: true });
    const plan = mkPlan("Legacy Plan", ["step 1"]);
    writeFileSync(legacyPath, JSON.stringify(plan, null, 2), "utf-8");

    const loaded = store.loadActive();
    expect(loaded).not.toBeNull();
    expect(loaded!.title).toContain("Legacy Plan");

    // Should have migrated to new location
    expect(existsSync(join(TEST_DIR, ".mma", "plans", "active.json"))).toBe(true);
    // Legacy file should be removed
    expect(existsSync(legacyPath)).toBe(false);
  });

  it("should track step progress in listing", () => {
    const plan = mkPlan("Progress Test", ["step 1", "step 2", "step 3"]);
    plan.steps[0].status = "done";
    plan.steps[1].status = "skipped";
    store.saveActive(plan);
    const all = store.listAll();
    expect(all[0].doneCount).toBe(2);
    expect(all[0].stepCount).toBe(3);
  });
});
