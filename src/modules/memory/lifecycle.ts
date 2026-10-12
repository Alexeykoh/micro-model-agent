/**
 * Контракт memory-модуля для `ModuleHost` (INV-2/5).
 *
 * Не критичен: без долговременной памяти агент работает, просто не помнит
 * прошлые сессии. Тулы `remember`/`recall` отдаются через единый путь сбора хоста.
 */
import type { ModuleDef } from "../../core/module-host";
import type { MemoryModule } from "./module";

/** Определение памяти: не критичен, тулы `remember`/`recall`. */
export function memoryModuleDef(memory: MemoryModule): ModuleDef {
  return {
    name: "memory",
    critical: false,
    tools: () => memory.getToolDefinitions(),
  };
}
