/**
 * Тул `document_find`: поиск по индексу документов (W5, INV-D4/D5/D6). Кэш
 * читается для каталога; если его нет — индекс собирается по требованию
 * (ограниченно). Выдача — top-N попаданий с ограниченными сниппетами. Нет
 * документов — fail-open с причиной; нет совпадений — честное сообщение.
 */
import { join, resolve } from "node:path";
import { t } from "../../../i18n/index";
import type { Logger } from "../../../logger/app-logger";
import type { ToolDefinition, ToolResult } from "../../../tools/types";
import { boundText, DEFAULT_DOC_LIMITS } from "../bound";
import { DocumentsCache, indexDir } from "../corpus";
import type { DocumentRegistry } from "../registry";
import { FIND_LIMIT, searchChunks, type SearchHit } from "../search";
import { causeOf, failResult, rejectResult } from "./run";

/** Одна строка выдачи: `rel:section — сниппет` (или `rel — сниппет`). */
function formatHits(hits: SearchHit[]): string {
  return hits
    .map((h) => `- ${h.section ? `${h.rel}:${h.section}` : h.rel} — ${h.snippet}`)
    .join("\n");
}

/** Тул `document_find`: поиск по корпусу с ленивой сборкой индекса (INV-D5/D6). */
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
        let entries = new DocumentsCache(cacheDir, { root }).load();
        if (!entries) {
          entries = (await indexDir({ baseDir: ctx.baseDir, dir, registry, logger: log })).entries;
          if (entries.length > 0) new DocumentsCache(cacheDir, { root }).save(entries);
        }
        if (entries.length === 0) {
          return rejectResult(ctx, "document_find", "no documents indexed", t("documents.no_index", { dir }));
        }
        const hits = searchChunks(entries, query, FIND_LIMIT);
        if (hits.length === 0) return { success: true, output: t("documents.no_matches", { query }) };
        return { success: true, output: boundText(formatHits(hits), DEFAULT_DOC_LIMITS) };
      } catch (err) {
        return failResult(ctx, "document_find", causeOf(err));
      }
    },
  };
}
