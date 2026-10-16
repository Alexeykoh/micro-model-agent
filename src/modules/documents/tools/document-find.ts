/**
 * Тул `document_find`: поиск по индексу документов (W5, INV-D4/D5/D6). Кэш
 * читается для каталога; инвентарь каталога сверяется с кэшем (`reconcile`):
 * добавленные/изменённые/удалённые документы отражаются автоматически. Нет/пуст
 * кэш — полная сборка по инвентарю. Нечитаемый каталог — fail-open с диагностикой.
 * Пустой снимок не сохраняется, иначе каталог выглядел бы пустым навсегда.
 */
import { join, resolve } from "node:path";
import { t } from "../../../i18n/index";
import type { Logger } from "../../../logger/app-logger";
import type { ToolDefinition, ToolResult } from "../../../tools/types";
import { boundText, DEFAULT_DOC_LIMITS } from "../bound";
import { buildEntries, DocumentsCache, fingerprint, inventoryDir } from "../corpus";
import type { DocEntry } from "../corpus";
import { reconcile } from "../reconcile";
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
        const cache = new DocumentsCache(join(ctx.baseDir, ".mma"), { root });
        const cached = cache.load();
        // Инвентарь каталога: добавленные/изменённые/удалённые видны без разбора.
        const inv = await inventoryDir(ctx.baseDir, dir, { registry, logger: log });
        // INV-D5: нечитаемый каталог — не «пусто», а честная ошибка с диагностикой.
        if (inv.error) return rejectResult(ctx, "document_find", inv.error, inv.error);
        const signature = fingerprint(inv.items);
        let entries: DocEntry[];
        if (!cached || cached.length === 0) {
          // Нет/пуст кэш — полная сборка по инвентарю (INV-D5).
          entries = (await buildEntries(inv.items, { baseDir: ctx.baseDir, registry, logger: log })).entries;
          if (entries.length > 0) cache.save(entries, signature);
        } else {
          // Сверка с инвентарём: переиспользовать/пересобрать/удалить (INV-D4/D5).
          const rec = await reconcile(cached, inv.items, { baseDir: ctx.baseDir, registry, logger: log });
          entries = rec.entries;
          // Пустой снимок не сохраняем: иначе каталог выглядит пустым навсегда.
          if (rec.changed > 0 && entries.length > 0) cache.save(entries, signature);
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
