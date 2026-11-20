/** AQC-6: структурная правка несколькими малыми hunk'ами за один вызов. */
import { readFileSync, writeFileSync } from "fs";
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import { scanContent } from "../modules/security/content-scanner";
import { logFileWrite, logSecurityBlock } from "../modules/security/audit-log";
import { getSessionSecurityConfig } from "../modules/security/session-isolation";
import { generateDiff } from "../ui/diff";
import { safeResolvePath } from "./path-utils";
import { assertWritable, recheckWrite } from "./path-guards";
import { preValidateSyntax } from "./syntax-validator";
import { spliceNormalized } from "./edit-file";
import { errMsg } from "../utils";

interface PatchEdit {
  old: string;
  new: string;
}

/**
 * Применяет все правки к содержимому, затем ОДИН раз проверяет синтаксис.
 * Промежуточные невалидные состояния не отвергаются — в отличие от построчной
 * перезаписи, где preValidateSyntax ломал каждый кусок.
 */
function applyEdits(content: string, edits: PatchEdit[]): string | { error: string } {
  let next = content;
  for (const edit of edits) {
    const applied = spliceNormalized(next, edit.old, edit.new);
    if (applied === null) {
      return { error: t("file.patch_anchor_missing", { snippet: edit.old.slice(0, 80) }) };
    }
    next = applied;
  }
  return next;
}

/** Меньше хunks/вызов: правит 5–20 строк, а не переписывает 7 КБ файл целиком. */
export const patchFileTool: ToolDefinition = {
  name: "patch_file",
  security: { caps: [{ fs: "write" }], pathArgs: ["path"] },
  icon: "🩹",
  description:
    "Apply 1..N small exact-match edits to an EXISTING file in one call. Prefer this over rewriting the whole file. Syntax is validated once after all edits.",
  tags: ["file", "code"],
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Existing file path" },
      edits: {
        type: "array",
        description: "Ordered {old,new} exact-match replacements",
        items: {
          type: "object",
          properties: {
            old: { type: "string", description: "Exact text to replace" },
            new: { type: "string", description: "Replacement text" },
          },
          required: ["old", "new"],
        },
      },
    },
    required: ["path", "edits"],
  },
  handler: async (ctx, args) => {
    if (typeof args.path !== "string" || args.path.trim() === "") {
      return {
        success: false,
        output: t("tool.path_arg_invalid", { tool: "patch_file", arg: "path" }),
      };
    }
    if (!Array.isArray(args.edits) || args.edits.length === 0) {
      return { success: false, output: t("file.patch_no_edits") };
    }
    const edits = args.edits as PatchEdit[];
    if (edits.some((e) => typeof e?.old !== "string" || typeof e?.new !== "string")) {
      return { success: false, output: t("file.patch_bad_edits") };
    }
    const path = args.path;
    const resolved = safeResolvePath(ctx.baseDir, path);
    const notAllowed = assertWritable(path, ctx);
    if (notAllowed) return notAllowed;

    const securityConfig = ctx.sessionContext
      ? getSessionSecurityConfig(ctx.config, ctx.sessionContext)
      : ctx.config.security;
    const maxFileOps = securityConfig?.maxFileOperations ?? 100;
    const currentCount = ctx.fileOperationsCount ?? 0;
    if (currentCount >= maxFileOps) {
      logSecurityBlock(ctx.sessionId, "file_write", `Maximum file operations (${maxFileOps}) exceeded`, path);
      return { success: false, output: `[SECURITY BLOCKED] Maximum file operations (${maxFileOps}) exceeded` };
    }

    let oldContent: string;
    try {
      oldContent = readFileSync(resolved, "utf-8");
    } catch (err) {
      return { success: false, output: t("file.write_failed", { path, error: errMsg(err) }) };
    }
    const patched = applyEdits(oldContent, edits);
    if (typeof patched !== "string") {
      return { success: false, output: patched.error };
    }

    if (securityConfig?.enabled && securityConfig?.contentScan?.enabled) {
      const scan = scanContent(patched, path, securityConfig.contentScan);
      if (!scan.allowed) {
        logSecurityBlock(ctx.sessionId, "file_write", scan.reason || "Content contains dangerous patterns", path);
        return { success: false, output: `[SECURITY BLOCKED] ${scan.reason}` };
      }
    }
    const unsafe = recheckWrite(resolved, ctx);
    if (unsafe) return unsafe;

    const validation = await preValidateSyntax(resolved, patched, ctx.baseDir);
    if (!validation.valid) {
      return {
        success: false,
        output: t("file.syntax_error", { path, error: validation.error || "Unknown syntax error" }),
      };
    }
    try {
      writeFileSync(resolved, patched, "utf-8");
    } catch (err) {
      return { success: false, output: t("file.write_failed", { path, error: errMsg(err) }) };
    }
    ctx.fileOperationsCount = currentCount + 1;
    logFileWrite(ctx.sessionId, path, true, `File patched (${edits.length} edits)`);
    return {
      success: true,
      output: t("file.patched", { path, count: String(edits.length) }),
      diff: generateDiff(oldContent, patched),
    };
  },
};
