/**
 * Контракт indexer-модуля для `ModuleHost` (INV-2/5/7).
 *
 * Не критичен: без карты проекта агент работает, контекст беднее. Держит
 * живого вотчера файловой системы, поэтому обязан объявить `teardown` —
 * `unwatch()` снимает подписку и дебаунс-таймер перестройки.
 */
import type { ModuleDef } from "../../core/module-host";
import type { IndexerModule } from "./module";

/** Определение индексера: не критичен; teardown снимает вотчер, тул `project_map`. */
export function indexerModuleDef(indexer: IndexerModule): ModuleDef {
  return {
    name: "indexer",
    critical: false,
    teardown: () => indexer.unwatch(),
    tools: () => indexer.getToolDefinitions(),
    hooks: () => indexer.getPlugin(),
  };
}
