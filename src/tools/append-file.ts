/** Тул дописывания файла: скоуп, security-скан, инкрементальный вывод. */
import { appendFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { dirname } from "path";
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import { scanContent } from "../modules/security/content-scanner";
import { logFileWrite, logSecurityBlock } from "../modules/security/audit-log";
import { getSessionSecurityConfig } from "../modules/security/session-isolation";
import { safeResolvePath } from "./path-utils";
import { assertWritable, recheckWrite } from "./path-guards";
import { errMsg } from "../utils";
import { preValidateSyntax } from "./syntax-validator";

/** Дописывает контент в файл, создавая его и parent-dirs; для длинного вывода. */
export const appendFileTool: ToolDefinition = {
  name: "append_file",
  security: { caps: [{ fs: "write" }], pathArgs: ["path"] },
  icon: "➕",
  boundedOutput: true,
  description:
    "Append content to a file (creating it and parent directories if needed). Prefer patch_file for existing code files. " +
    "When building a file in chunks, pass final:true on the LAST chunk to validate the whole file's syntax.",
  tags: ["file", "code"],
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      content: { type: "string", description: "Content to append" },
      final: {
        type: "boolean",
        description: "Set true on the last chunk to validate the whole file's syntax",
      },
    },
    required: ["path", "content"],
  },
  handler: async (ctx, args) => {
    const path = String(args.path);
    const resolved = safeResolvePath(ctx.baseDir, path);

    // Allowlist записи (аудит §4.4) — единая точка для мутирующих тулов.
    const notAllowed = assertWritable(path, ctx);
    if (notAllowed) return notAllowed;

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

    // TOCTOU: перед mkdir/append повторяем политику (см. write_file).
    const unsafeDir = recheckWrite(resolved, ctx);
    if (unsafeDir) return unsafeDir;
    const dir = dirname(resolved);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const unsafe = recheckWrite(resolved, ctx);
    if (unsafe) return unsafe;

    // AQC-6: промежуточные куски могут быть синтаксически неполными, но
    // последний обязан оставить валидный файл. Проверяем ДО записи.
    if (args.final === true) {
      const existing = existsSync(resolved) ? readFileSync(resolved, "utf-8") : "";
      const validation = await preValidateSyntax(resolved, existing + content, ctx.baseDir);
      if (!validation.valid) {
        return {
          success: false,
          output: t("file.syntax_error", { path, error: validation.error || "Unknown syntax error" }),
        };
      }
    }
    try {
      appendFileSync(resolved, content, "utf-8");
    } catch (err) {
      // Ошибка ФС (ENOSPC/EPERM/…) должна вернуть путь и причину, а не
      // вылететь голым Node-исключением в цикл агента.
      return {
        success: false,
        output: t("file.write_failed", { path, error: errMsg(err) }),
      };
    }

    // Счётчик файловых операций.
    ctx.fileOperationsCount = currentCount + 1;

    // Успешная запись в аудит-лог.
    logFileWrite(ctx.sessionId, path, true, "File appended");

    return {
      success: true,
      output: t("file.appended", { path, chars: String(content.length) }),
    };
  },
};
