import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import { isPathWritable } from "../modules/security/path-validator";
import { scanContent } from "../modules/security/content-scanner";
import { logFileWrite, logSecurityBlock } from "../modules/security/audit-log";
import { getSessionSecurityConfig } from "../modules/security/session-isolation";
import { generateDiff } from "../ui/diff";
import { safeResolvePath } from "./path-utils";

export const editFileTool: ToolDefinition = {
  name: "edit_file",
  description: "Find and replace text in an existing file. Uses exact string match (not regex).",
  tags: ["file", "code"],
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      old: { type: "string", description: "Text to replace" },
      new: { type: "string", description: "Replacement text" },
    },
    required: ["path", "old", "new"],
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

    const content = readFileSync(resolved, "utf-8");
    const oldStr = String(args.old);
    const newStr = String(args.new);
    if (!content.includes(oldStr)) {
      return {
        success: false,
        output: t("file.string_not_found", { str: oldStr }),
      };
    }

    const updated = content.replace(oldStr, newStr);

    // Check new content for dangerous patterns — only when security is enabled
    if (securityConfig?.enabled && securityConfig?.contentScan?.enabled) {
      const scanResult = scanContent(updated, path, securityConfig.contentScan);
      if (!scanResult.allowed) {
        logSecurityBlock(
          ctx.sessionId,
          "file_write",
          scanResult.reason || "Content contains dangerous patterns",
          path,
        );
        return {
          success: false,
          output: `[SECURITY BLOCKED] ${scanResult.reason}`,
        };
      }
    }

    writeFileSync(resolved, updated, "utf-8");
    const diff = generateDiff(content, updated);

    // Increment file operations counter
    (ctx as any).fileOperationsCount = currentCount + 1;

    // Log successful file edit
    logFileWrite(ctx.sessionId, path, true, "File edited");

    return { success: true, output: t("file.replaced_in", { path }), diff };
  },
};
