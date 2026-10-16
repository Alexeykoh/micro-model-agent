/**
 * Тул `document_read`: срез документа по селектору (INV-D5 — fail-open с
 * причиной; INV-D7 — декларация `security` обязательна).
 */
import { t } from "../../../i18n/index";
import type { ToolDefinition } from "../../../tools/types";
import { parseSelector, renderDocumentRead, type ReadOutcome } from "../read";
import { parseCtx, type DocumentRegistry } from "../registry";
import { fileSource } from "../source";
import { failOpen } from "./run";

/** Отказ рендера (`section` не найден / неизвестный селектор) → причина для модели. */
function failureMessage(outcome: Extract<ReadOutcome, { ok: false }>): string {
  if (outcome.kind === "unknown-selector") {
    return t("documents.selector_unknown", { selector: outcome.arg });
  }
  const available = outcome.available.length
    ? outcome.available.join(", ")
    : t("documents.section_none");
  return t("documents.section_not_found", { title: outcome.arg, available });
}

/** Тул `document_read`: срез по селектору (all/section/blocks). */
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
    handler: (ctx, args) =>
      failOpen(ctx, "document_read", async () => {
        const selector = parseSelector(String(args.selector ?? "all"));
        const source = fileSource(ctx.baseDir, String(args.path ?? ""));
        const ir = await registry.parse(parseCtx(ctx.logger), source);
        const outcome = renderDocumentRead(ir, selector);
        if (!outcome.ok) throw new Error(failureMessage(outcome));
        return outcome.text;
      }),
  };
}
