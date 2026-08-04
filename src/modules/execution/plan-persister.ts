import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { type Plan, type PlanStep, type StepStatus } from "./planner";

export interface PlanFile {
  id?: string;
  title: string;
  steps: PlanStep[];
  createdAt: string;
  updatedAt: string;
  baseDir?: string;
}

export class PlanPersister {
  private filePath: string;

  constructor(baseDir: string) {
    const mmaDir = join(baseDir, ".mma");
    if (!existsSync(mmaDir)) {
      mkdirSync(mmaDir, { recursive: true });
    }
    this.filePath = join(mmaDir, "plan.json");
  }

  save(plan: Plan): void {
    const file: PlanFile = {
      id: plan.id,
      title: plan.title,
      steps: plan.steps,
      createdAt: plan.createdAt,
      updatedAt: new Date().toISOString(),
      baseDir: plan.baseDir,
    };
    writeFileSync(this.filePath, JSON.stringify(file, null, 2), "utf-8");
  }

  load(): Plan | null {
    if (!existsSync(this.filePath)) return null;
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const file: PlanFile = JSON.parse(raw);
      return {
        id: file.id || "plan_legacy",
        title: file.title,
        steps: file.steps,
        createdAt: file.createdAt,
        baseDir: file.baseDir || process.cwd(),
      };
    } catch {
      return null;
    }
  }

  clear(): void {
    if (existsSync(this.filePath)) {
      writeFileSync(this.filePath, "", "utf-8");
    }
  }
}
