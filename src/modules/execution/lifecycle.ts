/**
 * Контракт execution-модуля для `ModuleHost` (INV-2/5).
 *
 * Не критичен: без активного плана агент продолжает работать (plan/todo — надстройка
 * качества, не условие запуска). Тулы отдаёт через единый путь сбора хоста
 * (`ModuleHost.collectTools`), а не через `ModuleRegistry`.
 */
import type { ModuleDef } from "../../core/module-host";
import type { ConfigKeyDef } from "../../config/registry";
import { REBUILD } from "../../config/effects";
import { DEFAULTS } from "../../config/defaults";
import type { ExecutionModule } from "./module";

/**
 * Ключ `execution.autoAdvance` — модуль-владелец объявляет его сам (INV-21),
 * а не ручная таблица `registry-extra`. Эффекты `REBUILD` — как было в
 * `registry-extra` (сохранение поведения: ранее `reconfigure: true`).
 */
const autoAdvanceKey: ConfigKeyDef = {
  key: "execution.autoAdvance",
  aliases: [],
  domain: "agent",
  valueType: "bool",
  effects: REBUILD,
  get: (c) => c.execution?.autoAdvance ?? DEFAULTS.execution?.autoAdvance ?? true,
  set: (c, v) => {
    c.execution ??= structuredClone(DEFAULTS.execution ?? { autoAdvance: true });
    c.execution.autoAdvance = v as boolean;
  },
};

/** Определение execution-модуля: не критичен, тулы — plan/plan_step/todo/verify. */
export function executionModuleDef(exec: ExecutionModule): ModuleDef {
  return {
    name: "execution",
    critical: false,
    tools: () => exec.getToolDefinitions(),
    hooks: () => exec.getPlugin(),
    configKeys: () => [autoAdvanceKey],
  };
}
