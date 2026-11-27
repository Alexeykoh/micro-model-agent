/** Тул просмотра отменяемых правок файлов в текущей сессии (newest first). */
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";

/** Список правок файловых тулов; bash-правки не отслеживаются. */
export const listFileChangesTool: ToolDefinition = {
  name: "list_file_changes",
  description:
    "List undoable file-tool changes in this session (newest first). Does not cover bash edits.",
  // `path` — только фильтр по журналу: файловая система по нему не читается,
  // поэтому pathArgs не нужен (проверка самих файлов — в точке чтения).
  security: { caps: [{ fs: "read" }] },
  icon: "🕘",
  tags: ["file-advanced"],
  boundedOutput: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Optional file path to filter by" },
      limit: { type: "integer", description: "Max entries, 1-50 (default 10)" },
    },
  },
  handler: async (ctx, args) => {
    if (!ctx.sessionId || !ctx.fileChanges) {
      return { success: false, output: t("changes.no_session") };
    }
    if (args.path !== undefined && (typeof args.path !== "string" || args.path.trim() === "")) {
      return { success: false, output: t("changes.invalid_path") };
    }
    const path = typeof args.path === "string" && args.path.trim() !== "" ? args.path : undefined;
    const limit = args.limit === undefined ? 10 : args.limit;
    if (
      typeof limit !== "number" ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50
    ) {
      return { success: false, output: t("changes.invalid_limit") };
    }
    const entries = ctx.fileChanges.list({
      sessionId: ctx.sessionId,
      baseDir: ctx.baseDir,
      path,
      limit,
    });
    if (entries.length === 0) return { success: true, output: t("changes.empty") };
    return {
      success: true,
      output: entries
        .map(
          (e) =>
            `${e.id} · ${t("changes.list.turn", { turn: String(e.turn) })} · ${e.tool} · ${e.op} · ${e.path}${e.skipped ? ` [${e.skipped}]` : ""}`,
        )
        .join("\n"),
    };
  },
};
