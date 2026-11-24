/** Тул просмотра отменяемых правок файлов в текущей сессии (newest first). */
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";

/** Список правок файловых тулов; bash-правки не отслеживаются. */
export const listFileChangesTool: ToolDefinition = {
  name: "list_file_changes",
  description:
    "List undoable file-tool changes in this session (newest first). Does not cover bash edits.",
  security: { caps: [{ fs: "read" }] },
  icon: "🕘",
  tags: ["file"],
  alwaysOn: true,
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
    const entries = ctx.fileChanges.list({
      sessionId: ctx.sessionId,
      baseDir: ctx.baseDir,
      path: args.path ? String(args.path) : undefined,
      limit: args.limit ? Number(args.limit) : 10,
    });
    if (entries.length === 0) return { success: true, output: t("changes.empty") };
    return {
      success: true,
      output: entries
        .map(
          (e) =>
            `${e.id} · turn ${e.turn} · ${e.tool} · ${e.op} · ${e.path}${e.skipped ? ` [${e.skipped}]` : ""}`,
        )
        .join("\n"),
    };
  },
};
