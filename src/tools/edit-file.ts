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
import { preValidateSyntax, detectImportConflicts } from "./syntax-validator";

export const editFileTool: ToolDefinition = {
  name: "edit_file",
  icon: "✏️",
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
        output: t("file.string_not_found", { str: oldStr, path }),
      };
    }

    // Replacement via function — otherwise newStr is treated as a template
    // and `$&`, `$1` etc. would silently corrupt the file content.
    const updated = content.replace(oldStr, () => newStr);

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

    // Pre-validate syntax BEFORE writing — prevents "file written" + syntax error loop
    const validation = await preValidateSyntax(resolved, updated, ctx.baseDir);
    if (!validation.valid) {
      return {
        success: false,
        output: t("file.syntax_error", { path, error: validation.error || "Unknown syntax error" }),
      };
    }

    // Detect import/export conflicts — warning only (code may be valid)
    const conflicts = detectImportConflicts(updated);

    writeFileSync(resolved, updated, "utf-8");
    const diff = generateDiff(content, updated);

    // Increment file operations counter
    (ctx as any).fileOperationsCount = currentCount + 1;

    // Log successful file edit
    logFileWrite(ctx.sessionId, path, true, "File edited");

    // Add conflict warning to output if any
    let output = t("file.replaced_in", { path });
    if (conflicts.length > 0) {
      output += `\n[WARNING] Import/export conflicts: ${conflicts.join(", ")}`;
    }

    return { success: true, output, diff };
  },
};
