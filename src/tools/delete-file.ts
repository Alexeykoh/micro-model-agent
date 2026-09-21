import { unlinkSync, existsSync, statSync, readFileSync } from "fs";
import { resolve } from "path";
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import { isPathWritable } from "../modules/security/path-validator";
import { logFileDelete, logSecurityBlock } from "../modules/security/audit-log";
import { getSessionSecurityConfig } from "../modules/security/session-isolation";
import { generateDeleteDiff } from "../ui/diff";
import { safeResolvePath } from "./path-utils";
import { protectedPathBlock } from "../modules/security/protected-paths";

export const deleteFileTool: ToolDefinition = {
  name: "delete_file",
  icon: "🗑️",
  description: "Delete a file from the filesystem.",
  tags: ["file"],
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
    },
    required: ["path"],
  },
  handler: async (ctx, args) => {
    const path = String(args.path);
    const resolved = safeResolvePath(ctx.baseDir, path);

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
        "file_delete",
        `Maximum file operations (${maxFileOps}) exceeded`,
        path,
      );
      return {
        success: false,
        output: `[SECURITY BLOCKED] Maximum file operations (${maxFileOps}) exceeded`,
      };
    }

    // Check path permissions
    const scopeCheck = isPathWritable(ctx.baseDir, resolved, ctx.scope, ctx.config.security?.paths);
    if (!scopeCheck.allowed) {
      logSecurityBlock(ctx.sessionId, "file_delete", scopeCheck.reason || "Path not allowed", path);
      return {
        success: false,
        output: t("file.path_not_allowed", {
          path: `${path} — ${scopeCheck.reason}`,
        }),
      };
    }

    // Protected paths (.git/, .env, keys/secrets) — always ask the user.
    const protectedBlock = protectedPathBlock(ctx, resolved, path, "file_delete");
    if (protectedBlock) return protectedBlock;

    if (!existsSync(resolved)) {
      return { success: false, output: t("file.notfound", { path }) };
    }
    if (statSync(resolved).isDirectory()) {
      return { success: false, output: t("file.is_directory", { path }) };
    }
    const content = readFileSync(resolved, "utf-8");
    unlinkSync(resolved);
    const diff = generateDeleteDiff(content);

    // Increment file operations counter
    ctx.fileOperationsCount = currentCount + 1;

    // Log successful file deletion
    logFileDelete(ctx.sessionId, path, true);

    return { success: true, output: t("file.deleted", { path }), diff };
  },
};
