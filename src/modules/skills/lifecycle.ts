/**
 * Контракт skills-модуля для `ModuleHost` (INV-5).
 *
 * Не критичен: без навыков агент работает. `load_skill` регистрируется ядром
 * (`createLoadSkillTool`), а промпт-блок навыков собирается динамически (INV-16),
 * поэтому вкладом модуль пока не объявлен — `ModuleDef` фиксирует существование
 * и место в жизненном цикле хоста.
 */
import type { ModuleDef } from "../../core/module-host";

/** Определение skills-модуля: не критичен, без собственных тулов. */
export function skillsModuleDef(): ModuleDef {
  return { name: "skills", critical: false };
}
