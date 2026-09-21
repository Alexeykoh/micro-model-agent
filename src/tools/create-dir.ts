import { mkdirSync, existsSync } from "fs";
import { resolve } from "path";
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import { isPathWritable } from "../modules/security/path-validator";
import { logFileWrite, logSecurityBlock } from "../modules/security/audit-log";
import { getSessionSecurityConfig } from "../modules/security/session-isolation";
import { safeResolvePath } from "./path-utils";
import { protectedPathBlock } from "../modules/security/protected-paths";

export const createDirTool: ToolDefinition = {
  name: "create_dir",
  icon: "📁",
  description: "Create a directory (and any intermediate directories).",
  tags: ["file"],
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path" },
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
        "file_write",
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
      logSecurityBlock(ctx.sessionId, "file_write", scopeCheck.reason || "Path not allowed", path);
      return {
        success: false,
        output: t("file.path_not_allowed", {
          path: `${path} — ${scopeCheck.reason}`,
        }),
      };
    }

    // Protected paths (.git/, .env dirs, …) — always ask the user.
    const protectedBlock = protectedPathBlock(ctx, resolved, path);
    if (protectedBlock) return protectedBlock;

    if (!existsSync(resolved)) {
      mkdirSync(resolved, { recursive: true });
    }

    // Increment file operations counter
    ctx.fileOperationsCount = currentCount + 1;

    // Log directory creation
    logFileWrite(ctx.sessionId, path, true, "Directory created");

    return { success: true, output: t("file.created", { path }) };
  },
};
