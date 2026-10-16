/**
 * JSON → `DocumentIR` (текстовая группа).
 */
import { boundText } from "../bound";
import { detectHead, type DocSource, type DocumentHandler, type ParseContext } from "../handler";
import { emptyIR } from "../ir";

/** JSON → IR: верхнеуровневые ключи в outline, форматированный JSON — code-блок. */
export const jsonHandler: DocumentHandler = {
  id: "json",
  group: "text",
  extensions: [".json", ".jsonc"],
  detect: (h) => detectHead(h) === "unknown",
  async parse(ctx: ParseContext, source: DocSource) {
    const bytes = await source.bytes();
    const text = new TextDecoder().decode(bytes);
    const ir = emptyIR("json", bytes.length);
    try {
      const data: unknown = JSON.parse(text);
      if (data && typeof data === "object" && !Array.isArray(data)) {
        for (const k of Object.keys(data)) ir.outline.push({ id: `k:${k}`, level: 1, title: k, kind: "section" });
      }
      ir.blocks.push({ kind: "code", lang: "json", text: boundText(JSON.stringify(data, null, 2), ctx.limits) });
    } catch (err) {
      ctx.logger.warn("documents: невалидный JSON — деградированный разбор", {
        path: source.path,
        reason: err instanceof Error ? err.message : String(err),
      });
      ir.meta.degraded = { reason: "invalid JSON — показан сырой текст" };
      ir.blocks.push({ kind: "code", lang: "json", text: boundText(text, ctx.limits) });
    }
    ir.meta.title = source.path;
    return ir;
  },
};
