/**
 * Тул `document_read`: срез документа по селектору (INV-D5 — fail-open с
 * причиной; INV-D7 — декларация `security` обязательна).
 */
import { t } from "../../../i18n/index";
import type { ToolContext, ToolDefinition, ToolResult } from "../../../tools/types";
import { parseSelector, renderDocumentRead } from "../read";
import { parseCtx, type DocumentRegistry } from "../registry";
import { fileSource } from "../source";

/** Тул `document_read`: срез по селектору (section/lines/all). */
export function documentReadTool(registry: DocumentRegistry): ToolDefinition {
  return {
    name: "document_read",
    security: { caps: [{ fs: "read" }], pathArgs: ["path"] },
    icon: "📄",
    tags: ["document", "file"],
    boundedOutput: true,
    cacheable: true,
    description: t("documents.read_desc"),
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: t("documents.path_desc") },
        selector: { type: "string", description: t("documents.selector_desc") },
      },
      required: ["path"],
    },
    handler: async (ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> => {
      const raw = String(args.path ?? "");
      const sel = parseSelector(String(args.selector ?? "all"));
      try {
        const source = fileSource(ctx.baseDir, raw);
        const ir = await registry.parse(parseCtx(ctx.logger), source);
        return { success: true, output: renderDocumentRead(ir, sel) };
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        ctx.onDiagnostic?.({
          source: "module:documents",
          operation: "document_read",
          kind: "failed",
          cause,
        });
        return { success: false, output: t("documents.error", { reason: cause }) };
      }
    },
  };
}
