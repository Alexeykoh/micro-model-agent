import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import type { Plan } from "./planner";

export type PlanStatus = "active" | "draft" | "archived";

export interface PlanMeta {
  id: string;
  name?: string;
  title: string;
  status: PlanStatus;
  createdAt: string;
  stepCount: number;
  doneCount: number;
}

const LEGACY_FILE = "plan.json";

function readPlanFile(path: string, fallbackBaseDir: string): Plan | null {
  try {
    const raw = readFileSync(path, "utf-8");
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.steps)) return null;
    return {
      id: parsed.id || "plan_legacy",
      title: parsed.title || "Legacy plan",
      steps: parsed.steps,
      createdAt: parsed.createdAt || new Date().toISOString(),
      baseDir: parsed.baseDir || fallbackBaseDir,
      name: parsed.name,
    };
  } catch {
    return null;
  }
}

function writePlanFile(path: string, plan: Plan): void {
  writeFileSync(path, JSON.stringify(plan, null, 2), "utf-8");
}

function listDir(dir: string, baseDir: string): Plan[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  return files
    .map((f) => readPlanFile(join(dir, f), baseDir))
    .filter((p): p is Plan => p !== null);
}

function toMeta(plan: Plan, status: PlanStatus): PlanMeta {
  return {
    id: plan.id,
    name: plan.name,
    title: plan.title,
    status,
    createdAt: plan.createdAt,
    stepCount: plan.steps.length,
    doneCount: plan.steps.filter((s) => s.status === "done" || s.status === "skipped").length,
  };
}

export class PlanStore {
  private baseDir: string;
  private plansDir: string;
  private draftsDir: string;
  private archiveDir: string;
  private legacyPath: string;

  constructor(baseDir: string) {
    const mmaDir = join(baseDir, ".mma");
    if (!existsSync(mmaDir)) mkdirSync(mmaDir, { recursive: true });

    this.baseDir = baseDir;
    this.plansDir = join(mmaDir, "plans");
    this.draftsDir = join(this.plansDir, "drafts");
    this.archiveDir = join(this.plansDir, "archive");
    this.legacyPath = join(mmaDir, LEGACY_FILE);

    for (const dir of [this.plansDir, this.draftsDir, this.archiveDir]) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
  }

  private activePath(): string {
    return join(this.plansDir, "active.json");
  }

  // ---- Active plan ----

  saveActive(plan: Plan): void {
    writePlanFile(this.activePath(), plan);
  }

  loadActive(): Plan | null {
    const activePath = this.activePath();
    if (existsSync(activePath)) {
      const plan = readPlanFile(activePath, this.baseDir);
      if (plan) return plan;
    }
    // Legacy migration: read .mma/plan.json and move to active
    if (existsSync(this.legacyPath)) {
      const legacy = readPlanFile(this.legacyPath, this.baseDir);
      if (legacy) {
        this.saveActive(legacy);
        try { rmSync(this.legacyPath, { force: true }); } catch {}
        return legacy;
      }
    }
    return null;
  }

  clearActive(): void {
    const p = this.activePath();
    if (existsSync(p)) rmSync(p, { force: true });
  }

  // ---- Drafts (saved plans) ----

  saveDraft(plan: Plan): void {
    writePlanFile(join(this.draftsDir, `${plan.id}.json`), plan);
  }

  loadDraft(id: string): Plan | null {
    const p = join(this.draftsDir, `${id}.json`);
    return existsSync(p) ? readPlanFile(p, this.baseDir) : null;
  }

  removeDraft(id: string): void {
    const p = join(this.draftsDir, `${id}.json`);
    if (existsSync(p)) rmSync(p, { force: true });
  }

  listDrafts(): Plan[] {
    return listDir(this.draftsDir, this.baseDir);
  }

  // ---- Archive ----

  archivePlan(plan: Plan): void {
    writePlanFile(join(this.archiveDir, `${plan.id}.json`), plan);
    // Remove from drafts if present
    this.removeDraft(plan.id);
    // If archived plan was active, clear active
    const active = this.loadActive();
    if (active && active.id === plan.id) {
      this.clearActive();
    }
  }

  listArchived(): Plan[] {
    return listDir(this.archiveDir, this.baseDir);
  }

  removeArchived(id: string): void {
    const p = join(this.archiveDir, `${id}.json`);
    if (existsSync(p)) rmSync(p, { force: true });
  }

  // ---- Cross-status queries ----

  listAll(): PlanMeta[] {
    const metas: PlanMeta[] = [];
    const active = this.loadActive();
    if (active) metas.push(toMeta(active, "active"));
    for (const p of this.listDrafts()) metas.push(toMeta(p, "draft"));
    for (const p of this.listArchived()) metas.push(toMeta(p, "archived"));
    return metas;
  }

  find(id: string): { plan: Plan; status: PlanStatus } | null {
    const active = this.loadActive();
    if (active && active.id === id) return { plan: active, status: "active" };
    const draft = this.loadDraft(id);
    if (draft) return { plan: draft, status: "draft" };
    const archived = this.listArchived().find((p) => p.id === id);
    if (archived) return { plan: archived, status: "archived" };
    return null;
  }
}
