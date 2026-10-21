/** Тул перемещения/переименования файла или каталога. */
import { renameSync, existsSync, mkdirSync } from "fs";
import { resolve, normalize, dirname } from "path";
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import { logFileWrite, logSecurityBlock } from "../modules/security/audit-log";
import { getSessionSecurityConfig } from "../modules/security/session-isolation";
import { generateMoveDiff } from "../ui/diff";
import { safeResolvePath } from "./path-utils";
import { assertWritable } from "./path-guards";

/** Перемещает/переименовывает; обе стороны проверяются по скоупу. */
export const moveFileTool: ToolDefinition = {
  name: "move_file",
  security: { caps: [{ fs: "write" }], pathArgs: ["from", "to"] },
  icon: "📦",
  description: "Move or rename a file or directory.",
  tags: ["file"],
  parameters: {
    type: "object",
    properties: {
      from: { type: "string", description: "Source path" },
      to: { type: "string", description: "Destination path" },
    },
    required: ["from", "to"],
  },
  handler: async (ctx, args) => {
    const fromPath = String(args.from);
    const toPath = String(args.to);
    const baseDir = resolve(ctx.baseDir);
    const fromResolved = safeResolvePath(baseDir, normalize(fromPath));
    const toResolved = safeResolvePath(baseDir, normalize(toPath));

    // Allowlist записи с обеих сторон (аудит §4.4).
    const notAllowed = assertWritable(fromPath, ctx) ?? assertWritable(toPath, ctx);
    if (notAllowed) return notAllowed;

    const securityConfig = ctx.sessionContext
      ? getSessionSecurityConfig(ctx.config, ctx.sessionContext)
      : ctx.config.security;

    // Лимит файловых операций.
    const maxFileOps = securityConfig?.maxFileOperations ?? 100;
    const currentCount = ctx.fileOperationsCount ?? 0;
    if (currentCount >= maxFileOps) {
      logSecurityBlock(
        ctx.sessionId,
        "file_write",
        `Maximum file operations (${maxFileOps}) exceeded`,
        `${fromPath} -> ${toPath}`,
      );
      return {
        success: false,
        output: `[SECURITY BLOCKED] Maximum file operations (${maxFileOps}) exceeded`,
      };
    }

    // Защищённые пути и скоуп с обеих сторон проверяет ToolExecutor (INV-10).
    if (!existsSync(fromResolved)) {
      return {
        success: false,
        output: t("file.not_found_short", { path: fromPath }),
      };
    }
    const toDir = dirname(toResolved);
    if (!existsSync(toDir)) {
      mkdirSync(toDir, { recursive: true });
    }
    renameSync(fromResolved, toResolved);
    const diff = generateMoveDiff(fromPath, toPath);

    ctx.fileOperationsCount = currentCount + 1;

    logFileWrite(ctx.sessionId, `${fromPath} -> ${toPath}`, true, "File moved");

    return {
      success: true,
      output: t("file.moved", { from: fromPath, to: toPath }),
      diff,
    };
  },
};
