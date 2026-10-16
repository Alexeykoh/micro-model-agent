/**
 * Определение модуля `documents` (INV-D3/D5/D7): некритичен, без настроек —
 * вкл/выкл только в коде (`handlers/index.ts`). Тулы собираются хостом
 * (`collectTools`), отдельной регистрации не требуют. Всего четыре тула —
 * жёсткий бюджет спеки для маленьких моделей: карта, чтение, индекс, поиск.
 */
import type { ModuleDef } from "../../core/module-host";
import { Logger } from "../../logger/app-logger";
import { buildRegistry, DOCUMENTS_ENABLED } from "./registry";
import { documentFindTool } from "./tools/document-find";
import { documentIndexTool } from "./tools/document-index";
import { documentMapTool } from "./tools/document-map";
import { documentReadTool } from "./tools/document-read";

/** Логер модуля для тулов, собираемых вне `setup()` (fallback к `ctx.logger`). */
const logger = new Logger("warn", "documents");

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
    tools: () =>
      DOCUMENTS_ENABLED
        ? [
            documentMapTool(registry),
            documentReadTool(registry),
            documentIndexTool(registry, logger),
            documentFindTool(registry, logger),
          ]
        : [],
  };
}
