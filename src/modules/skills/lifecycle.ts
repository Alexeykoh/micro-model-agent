/**
 * Контракт skills-модуля для `ModuleHost` (INV-5).
 *
 * Не критичен: без навыков агент работает. `load_skill` регистрируется ядром
 * (`createLoadSkillTool`), промпт-блок навыков собирается динамически (INV-16),
 * поэтому `promptBlocks` не объявлен — иначе блок задвоился бы в статике.
 */
import type { ModuleDef } from "../../core/module-host";
import type { SkillsModule } from "./module";

/** Определение skills-модуля: не критичен, без собственных тулов; хук — плагин скиллов. */
export function skillsModuleDef(skills: SkillsModule): ModuleDef {
  return {
    name: "skills",
    critical: false,
    hooks: () => skills.getPlugin(),
  };
}
