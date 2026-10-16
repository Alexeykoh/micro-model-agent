/**
 * YAML → `DocumentIR` (текстовая группа).
 */
import { parse as parseYaml } from "yaml";
import { boundText } from "../bound";
import { detectHead, type DocSource, type DocumentHandler, type ParseContext } from "../handler";
import { emptyIR } from "../ir";

/** YAML → IR: ключи верхнего уровня — в outline, документ — code-блок. */
export const yamlHandler: DocumentHandler = {
  id: "yaml",
  group: "text",
  extensions: [".yaml", ".yml"],
  detect: (h) => detectHead(h) === "unknown",
  async parse(ctx: ParseContext, source: DocSource) {
    const text = new TextDecoder().decode(await source.bytes());
    const ir = emptyIR("yaml", text.length);
    try {
      const data: unknown = parseYaml(text);
      if (data && typeof data === "object" && !Array.isArray(data)) {
        for (const k of Object.keys(data as Record<string, unknown>)) {
          ir.outline.push({ id: `k:${k}`, level: 1, title: k, kind: "section" });
        }
      }
    } catch {
      ir.meta.degraded = { reason: "invalid YAML — показан сырой текст" };
    }
    ir.blocks.push({ kind: "code", lang: "yaml", text: boundText(text, ctx.limits) });
    ir.meta.title = source.path;
    return ir;
  },
};
