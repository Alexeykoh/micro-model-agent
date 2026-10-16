/**
 * Тул `document_index`: пересобрать индекс каталога документов (W5, INV-D4/D5/D6).
 * Тонкая обёртка над `indexDir` + `DocumentsCache`: обойти, сохранить, вернуть
 * ограниченную сводку. Любая ошибка — fail-open с записью `module:documents`.
 */
import { join, resolve } from "node:path";
import { t } from "../../../i18n/index";
import type { Logger } from "../../../logger/app-logger";
import type { ToolDefinition } from "../../../tools/types";
import { DocumentsCache, indexDir, MAX_DOCUMENTS } from "../corpus";
import type { DocumentRegistry } from "../registry";
import { failOpen } from "./run";

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
    handler: (ctx, args) =>
      failOpen(ctx, "document_index", async () => {
        const dir = String(args.dir ?? ".").trim() || ".";
        const log = ctx.logger ?? logger;
        const res = await indexDir({ baseDir: ctx.baseDir, dir, registry, logger: log });
        // Пустой индекс не сохраняем: иначе `document_find` не увидит позже
        // добавленные документы (протухший пустой кэш лучше не писать).
        if (res.entries.length > 0) {
          new DocumentsCache(join(ctx.baseDir, ".mma"), { root: resolve(ctx.baseDir, dir) }).save(res.entries);
        }
        const chunks = res.entries.reduce((n, e) => n + e.chunks.length, 0);
        const summary = t("documents.index_summary", {
          documents: res.entries.length,
          chunks,
          skipped: res.skipped,
        });
        return res.truncated ? `${summary}\n${t("documents.index_truncated", { max: MAX_DOCUMENTS })}` : summary;
      }),
  };
}
