/** Тул удаления файла (с diff удалённого, security-проверки). */
import { unlinkSync, existsSync, statSync, readFileSync } from "fs";
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import { logFileDelete, logSecurityBlock } from "../modules/security/audit-log";
import { getSessionSecurityConfig } from "../modules/security/session-isolation";
import { generateDeleteDiff } from "../ui/diff";
import { safeResolvePath } from "./path-utils";

/** Удаляет файл; каталоги отклоняет. Возвращает diff удалённого. */
export const deleteFileTool: ToolDefinition = {
  name: "delete_file",
  security: { caps: [{ fs: "write" }], pathArgs: ["path"] },
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

    const securityConfig = ctx.sessionContext
      ? getSessionSecurityConfig(ctx.config, ctx.sessionContext)
      : ctx.config.security;

    // Лимит файловых операций.
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

    // Защищённые пути и скоуп проверяет ToolExecutor (INV-10).

    if (!existsSync(resolved)) {
      return { success: false, output: t("file.notfound", { path }) };
    }
    if (statSync(resolved).isDirectory()) {
      return { success: false, output: t("file.is_directory", { path }) };
    }
    const content = readFileSync(resolved, "utf-8");
    unlinkSync(resolved);
    const diff = generateDeleteDiff(content);

    ctx.fileOperationsCount = currentCount + 1;

    logFileDelete(ctx.sessionId, path, true);

    return { success: true, output: t("file.deleted", { path }), diff };
  },
};
