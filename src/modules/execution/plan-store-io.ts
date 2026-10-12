// Низкоуровневый IO планов: чтение/атомарная запись/листинг файлов (вынесено
// из `plan-store.ts`, правило ≤300). Без знания о доменах active/draft/archive.
import { readFileSync, writeFileSync, renameSync, rmSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { Logger } from "../../logger/app-logger";
import type { Plan } from "./planner";
import { errMsg } from "../../utils";

const log = new Logger("info", "plan-store");

/** Статус плана: активный, черновик, архив. */
export type PlanStatus = "active" | "draft" | "archived";

/** Метаданные плана для списков (без тел шагов). */
export interface PlanMeta {
  id: string;
  name?: string;
  title: string;
  status: PlanStatus;
  createdAt: string;
  stepCount: number;
  doneCount: number;
}

/** Читает файл плана; битый/пустой — null (не роняя сторы). */
export function readPlanFile(path: string, fallbackBaseDir: string): Plan | null {
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

/** Атомарная запись плана: крах посреди записи не оставит обрезанный файл. */
export function writePlanFile(path: string, plan: Plan): void {
  // Имя tmp уникально на процесс: два `mma` на общем `.mma/plans/active.json`
  // не уводят друг у друга `.tmp` (ENOENT).
  const tmpPath = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(plan, null, 2), "utf-8");
    renameSync(tmpPath, path);
  } catch (e) {
    try {
      if (existsSync(tmpPath)) rmSync(tmpPath);
    } catch {
      /* best-effort очистка */
    }
    log.warn(`failed to persist plan to ${path}`, { error: errMsg(e) });
    throw e;
  }
}

/** Читает все `.json`-планы из каталога. */
export function listDir(dir: string, baseDir: string): Plan[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  return files.map((f) => readPlanFile(join(dir, f), baseDir)).filter((p): p is Plan => p !== null);
}

/** Сводит план к метаданным для списков. */
export function toMeta(plan: Plan, status: PlanStatus): PlanMeta {
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
