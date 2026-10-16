/**
 * Тул `document_index`: пересобрать индекс каталога документов (W5, INV-D4/D5/D6).
 * Тонкая обёртка над `indexDir` + `DocumentsCache`: обойти, сохранить, вернуть
 * ограниченную сводку. Нечитаемый каталог — fail-open с диагностикой `module:documents`
 * и честным сообщением; прочая ошибка — fail-open с причиной.
 */
import { join, resolve } from "node:path";
import { t } from "../../../i18n/index";
import type { Logger } from "../../../logger/app-logger";
import type { ToolDefinition, ToolResult } from "../../../tools/types";
import { boundText, DEFAULT_DOC_LIMITS } from "../bound";
import { DocumentsCache, indexDir, MAX_DOCUMENTS, MAX_TOTAL_CHUNKS } from "../corpus";
import type { DocumentRegistry } from "../registry";
import { causeOf, failResult, rejectResult } from "./run";

/** Тул `document_index`: пересборка индекса корпуса в каталоге (INV-D5/D6). */
export function documentIndexTool(registry: DocumentRegistry, logger: Logger): ToolDefinition {
  return {
    name: "document_index",
    security: { caps: [{ fs: "read" }], pathArgs: ["dir"] },
    icon: "🗂️",
    tags: ["document", "file"],
    boundedOutput: true,
    cacheable: false,
    description: t("documents.index_desc"),
    parameters: {
      type: "object",
      properties: { dir: { type: "string", description: t("documents.dir_desc") } },
      required: [],
    },
    handler: async (ctx, args): Promise<ToolResult> => {
      try {
        const dir = String(args.dir ?? ".").trim() || ".";
        const log = ctx.logger ?? logger;
        const res = await indexDir({ baseDir: ctx.baseDir, dir, registry, logger: log });
        // INV-D5: нечитаемый каталог — не «пусто», а честная ошибка с диагностикой.
        if (res.error) return rejectResult(ctx, "document_index", res.error, res.error);
        // Пустой индекс не сохраняем: иначе `document_find` не увидит позже
        // добавленные документы (протухший пустой кэш лучше не писать).
        if (res.entries.length > 0) {
          new DocumentsCache(join(ctx.baseDir, ".mma"), { root: resolve(ctx.baseDir, dir) }).save(
            res.entries,
            res.signature,
          );
        }
        const chunks = res.entries.reduce((n, e) => n + e.chunks.length, 0);
        let output = t("documents.index_summary", {
          documents: res.entries.length,
          chunks,
          skipped: res.skipped,
        });
        if (res.truncated) {
          output +=
            "\n" +
            (res.truncatedBy === "chunks"
              ? t("documents.index_truncated_chunks", { max: MAX_TOTAL_CHUNKS })
              : t("documents.index_truncated", { max: MAX_DOCUMENTS }));
        }
        return { success: true, output: boundText(output, DEFAULT_DOC_LIMITS) };
      } catch (err) {
        return failResult(ctx, "document_index", causeOf(err));
      }
    },
  };
}
