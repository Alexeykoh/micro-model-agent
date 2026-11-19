/**
 * Тул `document_map`: карта структуры документа (INV-D5 — fail-open с
 * причиной; INV-D7 — декларация `security` обязательна).
 */
import { t } from "../../../i18n/index";
import type { ToolDefinition } from "../../../tools/types";
import { renderDocumentMap } from "../map";
import { parseCtx, type DocumentRegistry } from "../registry";
import { fileSource } from "../source";
import { failOpen } from "./run";

/** Тул `document_map`: карта структуры документа (INV-D5 — fail-open с причиной). */
export function documentMapTool(registry: DocumentRegistry): ToolDefinition {
  return {
    name: "document_map",
    security: { caps: [{ fs: "read" }], pathArgs: ["path"] },
    icon: "🗂️",
    tags: ["document", "file"],
    boundedOutput: true,
    cacheable: true,
    description: t("documents.map_desc"),
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: t("documents.path_desc") } },
      required: ["path"],
    },
    handler: (ctx, args) =>
      failOpen(ctx, "document_map", async () => {
        const source = fileSource(ctx.baseDir, String(args.path ?? ""));
        const ir = await registry.parse(parseCtx(ctx.logger), source);
        return renderDocumentMap(ir);
      }),
  };
}
