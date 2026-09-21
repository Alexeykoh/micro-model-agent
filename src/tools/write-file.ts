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
import { preValidateSyntax, detectImportConflicts } from "./syntax-validator";
import { errMsg } from "../utils";
import { protectedPathBlock } from "../modules/security/protected-paths";

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

    // Always-on fallback (security disabled): protected paths ask the user.
    const protectedBlock = protectedPathBlock(ctx, resolved, path);
    if (protectedBlock) return protectedBlock;

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

    // Pre-validate syntax BEFORE writing — prevents "file written" + syntax error loop
    const validation = await preValidateSyntax(resolved, content, ctx.baseDir);
    if (!validation.valid) {
      return {
        success: false,
        output: t("file.syntax_error", { path, error: validation.error || "Unknown syntax error" }),
      };
    }

    // Detect import/export conflicts — warning only (code may be valid)
    const conflicts = detectImportConflicts(content);

    const fileExists = existsSync(resolved);
    let oldContent = "";
    try {
      if (fileExists) {
        oldContent = readFileSync(resolved, "utf-8");
      }
      writeFileSync(resolved, content, "utf-8");
    } catch (err) {
      // Ошибка ФС (ENOSPC/EPERM/…) должна вернуть путь и причину, а не
      // вылететь голым Node-исключением в цикл агента.
      return {
        success: false,
        output: t("file.write_failed", { path, error: errMsg(err) }),
      };
    }
    const diff = fileExists ? generateDiff(oldContent, content) : generateNewFileDiff(content);

    // Increment file operations counter
    ctx.fileOperationsCount = currentCount + 1;

    // Log successful file write
    logFileWrite(ctx.sessionId, path, true, `File ${fileExists ? "updated" : "created"}`);

    // Add conflict warning to output if any
    let output = t("file.written", { path });
    if (conflicts.length > 0) {
      output += `\n[WARNING] Import/export conflicts: ${conflicts.join(", ")}`;
    }

    return { success: true, output, diff };
  },
};
