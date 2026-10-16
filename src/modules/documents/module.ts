/**
 * Определение модуля `documents` (INV-D3/D5/D7): некритичен, без настроек —
 * вкл/выкл только в коде (`handlers/index.ts`). Тулы собираются хостом
 * (`collectTools`), отдельной регистрации не требуют.
 */
import type { ModuleDef } from "../../core/module-host";
import { buildRegistry, DOCUMENTS_ENABLED } from "./registry";
import { documentMapTool } from "./tools/document-map";
import { documentReadTool } from "./tools/document-read";

/** Определение модуля `documents` (INV-D3/D5/D7): некритичен, без настроек. */
export function documentsModuleDef(): ModuleDef {
  const registry = buildRegistry();
  return {
    name: "documents",
    critical: false,
    requires: [],
    health: () => ({
      status: "ok",
      reason: DOCUMENTS_ENABLED ? undefined : "DOCUMENTS_ENABLED=false",
    }),
    tools: () => (DOCUMENTS_ENABLED ? [documentMapTool(registry), documentReadTool(registry)] : []),
  };
}
