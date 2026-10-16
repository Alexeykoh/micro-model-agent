/**
 * Тул `document_find`: поиск по индексу документов (W5, INV-D4/D5/D6). Кэш
 * читается для каталога; если его нет — индекс собирается по требованию
 * (ограниченно). Загруженный кэш сверяется со `stat` файлов (`refreshStale`) и
 * пересобирается при изменениях. Выдача — top-N попаданий с ограниченными
 * сниппетами. Нет документов — fail-open с причиной; нет совпадений — честное
 * сообщение.
 */
import { join, resolve } from "node:path";
import { t } from "../../../i18n/index";
import type { Logger } from "../../../logger/app-logger";
import type { ToolDefinition, ToolResult } from "../../../tools/types";
import { boundText, DEFAULT_DOC_LIMITS } from "../bound";
import { DocumentsCache, indexDir, refreshStale } from "../corpus";
import type { DocumentRegistry } from "../registry";
import { FIND_LIMIT, searchChunks, type SearchHit } from "../search";
import { causeOf, failResult, rejectResult } from "./run";

/** Одна строка выдачи: `rel:section — сниппет` (или `rel — сниппет`). */
function formatHits(hits: SearchHit[]): string {
  return hits
    .map((h) => `- ${h.section ? `${h.rel}:${h.section}` : h.rel} — ${h.snippet}`)
    .join("\n");
}

/** Тул `document_find`: поиск по корпусу с ленивой сборкой/освежением индекса (INV-D5/D6). */
export function documentFindTool(registry: DocumentRegistry, logger: Logger): ToolDefinition {
  return {
    name: "document_find",
    security: { caps: [{ fs: "read" }], pathArgs: ["dir"] },
    icon: "🔎",
    tags: ["document", "file"],
    boundedOutput: true,
    cacheable: false,
    description: t("documents.find_desc"),
    parameters: {
      type: "object",
      properties: {
        dir: { type: "string", description: t("documents.dir_desc") },
        query: { type: "string", description: t("documents.query_desc") },
      },
      required: ["query"],
    },
    handler: async (ctx, args): Promise<ToolResult> => {
      try {
        const query = String(args.query ?? "").trim();
        if (!query) throw new Error(t("documents.query_required"));
        const dir = String(args.dir ?? ".").trim() || ".";
        const log = ctx.logger ?? logger;
        const root = resolve(ctx.baseDir, dir);
        const cacheDir = join(ctx.baseDir, ".mma");
        const cache = new DocumentsCache(cacheDir, { root });
        let entries = cache.load();
        if (!entries) {
          const built = await indexDir({ baseDir: ctx.baseDir, dir, registry, logger: log });
          if (built.error) return rejectResult(ctx, "document_find", built.error, built.error);
          entries = built.entries;
          if (entries.length > 0) cache.save(entries);
        } else {
          // Свежесть: изменившиеся/исчезнувшие файлы пересобираются из кэша (INV-D4/D5).
          const refreshed = await refreshStale(entries, { baseDir: ctx.baseDir, registry, logger: log });
          if (refreshed.changed > 0) cache.save(refreshed.entries);
          entries = refreshed.entries;
        }
        if (entries.length === 0) {
          return rejectResult(
            ctx,
            "document_find",
            "no documents indexed",
            boundText(t("documents.no_index", { dir }), DEFAULT_DOC_LIMITS),
          );
        }
        const hits = searchChunks(entries, query, FIND_LIMIT);
        if (hits.length === 0) {
          return { success: true, output: boundText(t("documents.no_matches", { query }), DEFAULT_DOC_LIMITS) };
        }
        return { success: true, output: boundText(formatHits(hits), DEFAULT_DOC_LIMITS) };
      } catch (err) {
        return failResult(ctx, "document_find", causeOf(err));
      }
    },
  };
}
