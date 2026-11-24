/** Тул отката правок файловых тулов в текущей сессии. */
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";

/** Отменяет правку(и) файлового тула; при конфликте хеша просит force. */
export const restoreFileTool: ToolDefinition = {
  name: "restore_file",
  description:
    "Undo a file-tool edit in this session: one step by default, or every edit of a turn. " +
    "Coverage: file tools only — bash edits are not tracked. " +
    "Refuses when the file changed since the snapshot; read the file first or pass force.",
  security: { caps: [{ fs: "write" }], pathArgs: ["path"] },
  icon: "↩️",
  tags: ["file"],
  alwaysOn: true,
  boundedOutput: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (omit when undoing a whole turn)" },
      steps: { type: "integer", description: "How many undo steps (default 1)" },
      turn: { type: "integer", description: "Undo all changes of this turn instead of a path" },
      force: { type: "boolean", description: "Ignore hash conflicts; never bypasses path policy" },
    },
  },
  handler: async (ctx, args) => {
    if (!ctx.sessionId || !ctx.fileChanges) {
      return { success: false, output: t("changes.no_session") };
    }
    const result = ctx.fileChanges.undo({
      sessionId: ctx.sessionId,
      baseDir: ctx.baseDir,
      path: args.path ? String(args.path) : undefined,
      steps: args.steps ? Number(args.steps) : 1,
      turn: args.turn ? Number(args.turn) : undefined,
      force: args.force === true,
    });
    return {
      success: result.ok,
      output: result.message,
      ...(result.diff ? { diff: result.diff } : {}),
    };
  },
};
