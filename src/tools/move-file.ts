import { renameSync, existsSync, mkdirSync } from "fs";
import { resolve, normalize, dirname } from "path";
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import { isPathWritable } from "../modules/security/path-validator";
import { logFileWrite, logSecurityBlock } from "../modules/security/audit-log";
import { getSessionSecurityConfig } from "../modules/security/session-isolation";
import { generateMoveDiff } from "../ui/diff";
import { safeResolvePath } from "./path-utils";

export const moveFileTool: ToolDefinition = {
  name: "move_file",
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

    // Get session-specific security config
    const securityConfig = ctx.sessionContext
      ? getSessionSecurityConfig(ctx.config, ctx.sessionContext)
      : ctx.config.security;

    // Check file operations limit
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

    // Check source path permissions — against the RESOLVED path (the same
    // one renameSync will act on), never the raw argument.
    const fromCheck = isPathWritable(ctx.baseDir, fromResolved, ctx.scope, ctx.config.security?.paths);
    if (!fromCheck.allowed) {
      logSecurityBlock(
        ctx.sessionId,
        "file_write",
        fromCheck.reason || "Source path not allowed",
        fromPath,
      );
      return {
        success: false,
        output: t("file.path_not_allowed", {
          path: `${fromPath} — ${fromCheck.reason}`,
        }),
      };
    }

    // Check destination path permissions — resolved, same as above.
    const toCheck = isPathWritable(ctx.baseDir, toResolved, ctx.scope, ctx.config.security?.paths);
    if (!toCheck.allowed) {
      logSecurityBlock(
        ctx.sessionId,
        "file_write",
        toCheck.reason || "Destination path not allowed",
        toPath,
      );
      return {
        success: false,
        output: t("file.path_not_allowed", {
          path: `${toPath} — ${toCheck.reason}`,
        }),
      };
    }

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

    // Increment file operations counter
    (ctx as any).fileOperationsCount = currentCount + 1;

    // Log file move
    logFileWrite(ctx.sessionId, `${fromPath} -> ${toPath}`, true, "File moved");

    return {
      success: true,
      output: t("file.moved", { from: fromPath, to: toPath }),
      diff,
    };
  },
};
