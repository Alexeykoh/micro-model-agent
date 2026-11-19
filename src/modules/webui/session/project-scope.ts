// Привязка сессии к проекту: `mma web` работает в одном workspace, поэтому
// сессии чужого каталога не должны попадать в список и не должны приниматься
// ходом. Мета без `projectDir` (старые записи) считается «не ограниченной» —
// иначе апгрейд прятал бы историю, созданную до появления поля.
import { resolve } from "node:path";

/** Нормализация пути для сравнения: регистр и хвостовые слэши не значимы. */
export function normalizeProjectPath(dir: string): string {
  const normalized = resolve(dir).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Минимум меты, нужный для проверки принадлежности проекту. */
export interface ProjectScopedMeta {
  projectDir?: string;
}

/**
 * Принадлежит ли сессия текущему workspace. Нет `workspace` или `projectDir`
 * — считаем принадлежащей (fail-open: не прячем историю из-за отсутствия поля).
 */
export function inWorkspace(meta: ProjectScopedMeta, workspace: string | undefined): boolean {
  if (!meta.projectDir || !workspace) return true;
  return normalizeProjectPath(meta.projectDir) === normalizeProjectPath(workspace);
}
