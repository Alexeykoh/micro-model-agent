import { readFileSync, writeFileSync } from "fs";
import { resolve, normalize } from "path";
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import { isPathWritable } from "../modules/security/path-validator";
import { scanContent } from "../modules/security/content-scanner";
import { logFileWrite, logSecurityBlock } from "../modules/security/audit-log";
import { generateDiff } from "../ui/diff";

export const editFileTool: ToolDefinition = {
  name: "edit_file",
  description:
    "Find and replace text in an existing file. Uses exact string match (not regex).",
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
    const baseDir = resolve(ctx.baseDir);
    const resolved = resolve(baseDir, normalize(path));
    
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
    
    // Check new content for dangerous patterns
    const scanResult = scanContent(updated, path, ctx.config.security?.contentScan);
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
    
    writeFileSync(resolved, updated, "utf-8");
    const diff = generateDiff(content, updated);
    
    // Log successful file edit
    logFileWrite(ctx.sessionId, path, true, "File edited");
    
    return { success: true, output: t("file.replaced_in", { path }), diff };
  },
};
