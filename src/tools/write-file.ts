/** Тул записи файла: скоуп, security-скан, валидация синтаксиса, diff. */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import { scanContent } from "../modules/security/content-scanner";
import { logFileWrite, logSecurityBlock } from "../modules/security/audit-log";
import { getSessionSecurityConfig } from "../modules/security/session-isolation";
import { generateDiff, generateNewFileDiff } from "../ui/diff";
import { safeResolvePath } from "./path-utils";
import { preValidateSyntax, detectImportConflicts } from "./syntax-validator";
import { errMsg } from "../utils";

/** Создаёт/перезаписывает файл; parent-dirs, проверки, diff в ответе. */
export const writeFileTool: ToolDefinition = {
  name: "write_file",
  security: { caps: [{ fs: "write" }], pathArgs: ["path"] },
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

    // Скан контента на опасные паттерны — только при включённой безопасности.
    // У contentScan свой флаг `enabled`, но при выключенном глобальном свитче
    // он молчит (ложные срабатывания на обычном CLI-коде).
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

    // Превалидация синтаксиса ДО записи — иначе петля "файл записан" + syntax error.
    const validation = await preValidateSyntax(resolved, content, ctx.baseDir);
    if (!validation.valid) {
      return {
        success: false,
        output: t("file.syntax_error", { path, error: validation.error || "Unknown syntax error" }),
      };
    }

    // Конфликты import/export — только warning (код может быть валиден).
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

    // Счётчик файловых операций.
    ctx.fileOperationsCount = currentCount + 1;

    // Успешная запись в аудит-лог.
    logFileWrite(ctx.sessionId, path, true, `File ${fileExists ? "updated" : "created"}`);

    // Предупреждение о конфликтах — в вывод.
    let output = t("file.written", { path });
    if (conflicts.length > 0) {
      output += `\n[WARNING] Import/export conflicts: ${conflicts.join(", ")}`;
    }

    return { success: true, output, diff };
  },
};
