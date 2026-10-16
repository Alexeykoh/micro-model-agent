/**
 * Тул `document_map`: карта структуры документа (INV-D5 — fail-open с причиной;
 * INV-D7 — декларация `security` обязательна).
 */
import { t } from "../../../i18n/index";
import type { ToolContext, ToolDefinition, ToolResult } from "../../../tools/types";
import { renderDocumentMap } from "../map";
import { parseCtx, type DocumentRegistry } from "../registry";
import { fileSource } from "../source";

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
    handler: async (ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> => {
      const raw = String(args.path ?? "");
      try {
        const source = fileSource(ctx.baseDir, raw);
        const ir = await registry.parse(parseCtx(ctx.logger), source);
        return { success: true, output: renderDocumentMap(ir) };
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        ctx.onDiagnostic?.({
          source: "module:documents",
          operation: "document_map",
          kind: "failed",
          cause,
        });
        return { success: false, output: t("documents.error", { reason: cause }) };
      }
    },
  };
}
