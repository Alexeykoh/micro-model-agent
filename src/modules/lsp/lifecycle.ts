/**
 * Контракт LSP-модуля для `ModuleHost` (INV-5/7).
 *
 * LSP не критичен (без языкового сервера агент работает, проверки деградируют)
 * и держит живые процессы серверов, поэтому обязан объявить `teardown` —
 * закрытие пула теперь часть контракта, а не деталь одного плагин-хука.
 */
import type { ModuleDef } from "../../core/module-host";
import type { LspModule } from "./module";

/** Определение LSP для `ModuleHost`: не критичен, teardown = закрыть серверы. */
export function lspModuleDef(lsp: LspModule): ModuleDef {
  return {
    name: "lsp",
    critical: false,
    teardown: () => lsp.close(),
    tools: () => lsp.getToolDefinitions(),
    hooks: () => lsp.getPlugin(),
  };
}
