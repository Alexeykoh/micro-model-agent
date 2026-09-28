/** Тул точечной правки: exact-match замена, скан, валидация, diff. */
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
import { errMsg } from "../utils";
import { protectedPathBlock } from "../modules/security/protected-paths";

/** Заменяет точный фрагмент в существующем файле (не regex). */
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

    if (ctx.writePathAllowlist) {
      const ok = ctx.writePathAllowlist.some(
        (p) => resolve(p).toLowerCase() === resolve(resolved).toLowerCase(),
      );
      if (!ok) {
        return {
          success: false,
          output: t("file.path_not_allowed", {
            path: `${path} — ${t("onboarding.write_restricted")}`,
            reason: t("onboarding.write_restricted"),
          }),
        };
      }
    }

    // Сессионный security-конфиг.
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

    // Проверка прав на путь.
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

    // Защищённые пути (.git/, .env, ключи) — всегда спросить юзера.
    const protectedBlock = protectedPathBlock(ctx, resolved, path);
    if (protectedBlock) return protectedBlock;

    // Строковые аргументы обязательны: String(null) дало бы "null" и молча
    // испортило файл. Явно отклоняем не-строки с понятной ошибкой.
    if (typeof args.old !== "string" || typeof args.new !== "string") {
      return {
        success: false,
        output: t("file.edit_args_invalid", {
          oldType: typeof args.old,
          newType: typeof args.new,
        }),
      };
    }
    const oldStr = args.old;
    const newStr = args.new;

    let content: string;
    try {
      content = readFileSync(resolved, "utf-8");
    } catch (err) {
      return {
        success: false,
        output: t("file.read_failed", { path, error: errMsg(err) }),
      };
    }
    if (!content.includes(oldStr)) {
      return {
        success: false,
        output: t("file.string_not_found", { str: oldStr, path }),
      };
    }

    // Замена через функцию — иначе newStr трактуется как шаблон и `$&`, `$1`
    // молча испортят содержимое файла.
    const updated = content.replace(oldStr, () => newStr);

    // Скан нового контента — только при включённой безопасности.
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

    // Превалидация синтаксиса ДО записи — иначе петля "файл записан" + syntax error.
    const validation = await preValidateSyntax(resolved, updated, ctx.baseDir);
    if (!validation.valid) {
      return {
        success: false,
        output: t("file.syntax_error", { path, error: validation.error || "Unknown syntax error" }),
      };
    }

    // Конфликты import/export — только warning.
    const conflicts = detectImportConflicts(updated);

    writeFileSync(resolved, updated, "utf-8");
    const diff = generateDiff(content, updated);

    ctx.fileOperationsCount = currentCount + 1;

    logFileWrite(ctx.sessionId, path, true, "File edited");

    let output = t("file.replaced_in", { path });
    if (conflicts.length > 0) {
      output += `\n[WARNING] Import/export conflicts: ${conflicts.join(", ")}`;
    }

    return { success: true, output, diff };
  },
};
