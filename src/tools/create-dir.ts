import { mkdirSync, existsSync } from "fs";
import { resolve, normalize } from "path";
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import { isPathWritable } from "../modules/security/path-validator";
import { logFileWrite, logSecurityBlock } from "../modules/security/audit-log";

export const createDirTool: ToolDefinition = {
  name: "create_dir",
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
    const baseDir = resolve(ctx.baseDir);
    const resolved = resolve(baseDir, normalize(path));
    
    // Check file operations limit
    const maxFileOps = ctx.config.security?.maxFileOperations ?? 100;
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
    const scopeCheck = isPathWritable(ctx.baseDir, path, ctx.scope, ctx.config.security?.paths);
    if (!scopeCheck.allowed) {
      logSecurityBlock(
        ctx.sessionId,
        "file_write",
        scopeCheck.reason || "Path not allowed",
        path,
      );
      return {
        success: false,
        output: t("file.path_not_allowed", {
          path: `${path} — ${scopeCheck.reason}`,
        }),
      };
    }
    
    if (!existsSync(resolved)) {
      mkdirSync(resolved, { recursive: true });
    }
    
    // Increment file operations counter
    (ctx as any).fileOperationsCount = currentCount + 1;
    
    // Log directory creation
    logFileWrite(ctx.sessionId, path, true, "Directory created");
    
    ctx.trackCreatedPath?.(path);
    return { success: true, output: t("file.created", { path }) };
  },
};
