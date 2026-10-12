/**
 * Контракт session-модуля для `ModuleHost` (INV-5).
 *
 * Не критичен: без сессионного блока агент работает. Своих тулов не имеет, а
 * системный блок сессии собирается динамически (INV-16, `assembleDynamicPromptBlocks`),
 * поэтому вкладом пока не объявлен — `ModuleDef` фиксирует существование и место
 * модуля в жизненном цикле хоста.
 */
import type { ModuleDef } from "../../core/module-host";

/** Определение session-модуля: не критичен, без тулов. */
export function sessionModuleDef(): ModuleDef {
  return { name: "session", critical: false };
}
