/** Тул отката правок файловых тулов в текущей сессии. */
import { t } from "../i18n/index";
import type { UndoResult } from "../modules/changes/types";
import { checkToolPath } from "./path-enforcement";
import type { ToolDefinition } from "./types";

/** Точные причины из `src/modules/changes/undo.ts`; неизвестные строки не трогаем. */
const REASON_KEYS: Readonly<Record<string, string>> = {
  "file changed since the snapshot": "changes.reason.file_changed",
  "move destination changed since the snapshot": "changes.reason.move_changed",
  "path is outside the base directory": "changes.reason.outside_base",
  "path does not match its absolute path": "changes.reason.path_mismatch",
  "path is a symbolic link": "changes.reason.symlink",
  "base directory is unavailable": "changes.reason.no_base",
  "path resolves outside the base directory": "changes.reason.resolves_outside",
  "move destination is outside the base directory": "changes.reason.move_outside",
  "invalid steps: expected a positive integer": "changes.reason.invalid_steps",
  "not enough undo steps for this file": "changes.reason.few_steps",
};

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
    ? value
    : undefined;
}

function localizeReason(reason: string): string {
  const key = REASON_KEYS[reason];
  if (key) return t(key);
  const evictedFile = /^snapshot for (.+) was evicted; no undoable version remains$/.exec(reason);
  if (evictedFile) return t("changes.reason.evicted_file", { path: evictedFile[1]! });
  const noTurn = /^no changes recorded in turn (\d+)$/.exec(reason);
  if (noTurn) return t("changes.reason.no_turn_changes", { turn: noTurn[1]! });
  const evictedTurn = /^snapshots for turn (\d+) were evicted$/.exec(reason);
  if (evictedTurn) return t("changes.reason.evicted_turn", { turn: evictedTurn[1]! });
  const moveDest = /^move destination (.+)$/.exec(reason);
  if (moveDest && REASON_KEYS[moveDest[1]!]) {
    return t("changes.reason.move_destination", { reason: localizeReason(moveDest[1]!) });
  }
  return reason;
}

/** Локализованный результат undo: общий вывод для тула restore_file и CLI. */
export function localizeOutput(result: UndoResult): string {
  const detail = result.items.length
    ? result.items
        .map((item) =>
          item.ok
            ? `${item.path}: ${t("changes.reason.restored")}`
            : `${item.path}: ${t("changes.reason.skipped", {
                reason: localizeReason(item.reason ?? t("changes.reason.unknown")),
              })}`,
        )
        .join("; ")
    : localizeReason(result.message);
  return t(result.ok ? "changes.result_ok" : "changes.result_fail", { detail });
}

/** Отменяет правку(и) файлового тула; при конфликте хеша просит force. */
export const restoreFileTool: ToolDefinition = {
  name: "restore_file",
  description:
    "Undo a file-tool edit in this session. With `path`, undo one step by default " +
    "(use `steps` for more). Without `path`, pass an explicit `turn` to undo every " +
    "change of that turn — there is no implicit current-turn default. A call with " +
    "neither `path` nor `turn` is rejected. Coverage: file tools only — bash edits " +
    "are not tracked. Refuses when the file changed since the snapshot; read the " +
    "file first or pass force.",
  security: { caps: [{ fs: "write" }], pathArgs: ["path"] },
  icon: "↩️",
  tags: ["file"],
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
    if (args.path !== undefined && (typeof args.path !== "string" || args.path.trim() === "")) {
      return { success: false, output: t("changes.invalid_path") };
    }
    const path = typeof args.path === "string" && args.path.trim() !== "" ? args.path : undefined;

    const turn = args.turn === undefined ? undefined : positiveInt(args.turn);
    if (args.turn !== undefined && turn === undefined) {
      return { success: false, output: t("changes.invalid_turn") };
    }
    if (path !== undefined && turn !== undefined) {
      return { success: false, output: t("changes.path_and_turn") };
    }
    if (path === undefined && turn === undefined) {
      return { success: false, output: t("changes.path_or_turn_required") };
    }

    const steps = args.steps === undefined ? 1 : positiveInt(args.steps);
    if (steps === undefined) return { success: false, output: t("changes.invalid_steps") };

    const result = ctx.fileChanges.undo({
      sessionId: ctx.sessionId,
      baseDir: ctx.baseDir,
      path,
      steps,
      turn,
      force: args.force === true,
      // Политика путей для всех восстанавливаемых путей (особенно в turn-режиме).
      authorize: (restoredPath) =>
        checkToolPath(ctx, restoreFileTool.security, restoredPath, ctx.activeCallId ?? "")?.output ??
        null,
    });
    return {
      success: result.ok,
      output: localizeOutput(result),
      ...(result.diff ? { diff: result.diff } : {}),
    };
  },
};
