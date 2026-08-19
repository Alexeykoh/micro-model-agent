import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import { isPathWritable } from "../modules/security/path-validator";
import { scanContent } from "../modules/security/content-scanner";
import { logFileWrite, logSecurityBlock } from "../modules/security/audit-log";
import { getSessionSecurityConfig } from "../modules/security/session-isolation";
import { generateDiff, generateNewFileDiff } from "../ui/diff";
import { safeResolvePath } from "./path-utils";

export const writeFileTool: ToolDefinition = {
  name: "write_file",
  icon: "📝",
  description:
    "Create or overwrite a file with given content. Creates intermediate directories if needed.",
  tags: ["file", "code"],
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      content: { type: "string", description: "File content" },
    },
    required: ["path", "content"],
  },
  handler: async (ctx, args) => {
    const path = String(args.path);
    const resolved = safeResolvePath(ctx.baseDir, path);

    // Check path permissions using the resolved path
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

    // Check content for dangerous patterns — only when security is enabled.
    // contentScan has its own `enabled` flag, but it must NOT fire while the
    // global security switch is off (false positives on ordinary CLI code).
    const content = String(args.content);
    if (securityConfig?.enabled && securityConfig?.contentScan?.enabled) {
      const scanResult = scanContent(content, path, securityConfig.contentScan);
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

    const dir = dirname(resolved);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const fileExists = existsSync(resolved);
    let oldContent = "";
    if (fileExists) {
      oldContent = readFileSync(resolved, "utf-8");
    }
    writeFileSync(resolved, content, "utf-8");
    const diff = fileExists ? generateDiff(oldContent, content) : generateNewFileDiff(content);

    // Increment file operations counter
    (ctx as any).fileOperationsCount = currentCount + 1;

    // Log successful file write
    logFileWrite(ctx.sessionId, path, true, `File ${fileExists ? "updated" : "created"}`);

    return { success: true, output: t("file.written", { path }), diff };
  },
};
