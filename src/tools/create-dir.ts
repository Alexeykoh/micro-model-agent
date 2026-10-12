/** Тул создания каталога (рекурсивно, с security-проверками). */
import { mkdirSync, existsSync } from "fs";
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import { logFileWrite, logSecurityBlock } from "../modules/security/audit-log";
import { getSessionSecurityConfig } from "../modules/security/session-isolation";
import { safeResolvePath } from "./path-utils";

/** Создаёт каталог со всеми промежуточными. */
export const createDirTool: ToolDefinition = {
  name: "create_dir",
  security: { caps: [{ fs: "write" }], pathArgs: ["path"] },
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

    const securityConfig = ctx.sessionContext
      ? getSessionSecurityConfig(ctx.config, ctx.sessionContext)
      : ctx.config.security;

    // Лимит файловых операций.
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

    if (!existsSync(resolved)) {
      mkdirSync(resolved, { recursive: true });
    }

    ctx.fileOperationsCount = currentCount + 1;

    logFileWrite(ctx.sessionId, path, true, "Directory created");

    return { success: true, output: t("file.created", { path }) };
  },
};
