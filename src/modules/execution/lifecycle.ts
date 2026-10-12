/**
 * Контракт execution-модуля для `ModuleHost` (INV-2/5).
 *
 * Не критичен: без активного плана агент продолжает работать (plan/todo — надстройка
 * качества, не условие запуска). Тулы отдаёт через единый путь сбора хоста
 * (`ModuleHost.collectTools`), а не через `ModuleRegistry`.
 */
import type { ModuleDef } from "../../core/module-host";
import type { ExecutionModule } from "./module";

/** Определение execution-модуля: не критичен, тулы — plan/plan_step/todo/verify. */
export function executionModuleDef(exec: ExecutionModule): ModuleDef {
  return {
    name: "execution",
    critical: false,
    tools: () => exec.getToolDefinitions(),
  };
}
