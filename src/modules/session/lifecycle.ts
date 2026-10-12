/**
 * Контракт session-модуля для `ModuleHost` (INV-5).
 *
 * Не критичен: без сессионного блока агент работает. Своих тулов не имеет, а
 * системный блок сессии собирается динамически (INV-16, `assembleDynamicPromptBlocks`),
 * поэтому `promptBlocks` не объявлен — иначе блок задвоился бы в статике.
 */
import type { ModuleDef } from "../../core/module-host";
import type { SessionModule } from "./module";

/** Определение session-модуля: не критичен, без тулов; хук — плагин сессии. */
export function sessionModuleDef(session: SessionModule): ModuleDef {
  return {
    name: "session",
    critical: false,
    hooks: () => session.getPlugin(),
  };
}
