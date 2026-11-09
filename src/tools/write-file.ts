/** Тул записи файла: скоуп, security-скан, валидация синтаксиса, diff. */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { dirname } from "path";
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import { scanContent } from "../modules/security/content-scanner";
import { logFileWrite, logSecurityBlock } from "../modules/security/audit-log";
import { getSessionSecurityConfig } from "../modules/security/session-isolation";
import { generateDiff, generateNewFileDiff } from "../ui/diff";
import { safeResolvePath } from "./path-utils";
import { assertWritable, recheckWrite } from "./path-guards";
import { preValidateSyntax, detectImportConflicts } from "./syntax-validator";
import { errMsg } from "../utils";

/** Лимит одного `write_file` (символов). Больше — кусками через `append_file`. */
export const WRITE_CHUNK_LIMIT = 8000;

function writeTooLargeOutput(path: string, size: number): string {
  return t("file.write_too_large", {
    path,
    size: String(size),
    limit: String(WRITE_CHUNK_LIMIT),
  });
}

export function validateWriteChunk(
  path: string,
  content: string,
): { ok: true } | { ok: false; output: string } {
  if (content.length > WRITE_CHUNK_LIMIT) {
    return { ok: false, output: writeTooLargeOutput(path, content.length) };
  }
  return { ok: true };
}

/** Создаёт/перезаписывает файл; parent-dirs, проверки, diff в ответе. */
export const writeFileTool: ToolDefinition = {
  name: "write_file",
  security: { caps: [{ fs: "write" }], pathArgs: ["path"] },
  icon: "📝",
  description:
    "Create or overwrite a file with given content. Creates intermediate directories if needed. " +
    "For content longer than ~6000 chars, write the first part with write_file and append the rest with append_file chunks (≤8000 chars per call).",
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
    if (typeof args.path !== "string" || args.path.trim() === "") {
      return {
        success: false,
        output: t("tool.path_arg_invalid", { tool: "write_file", arg: "path" }),
      };
    }
    const path = args.path;
    const resolved = safeResolvePath(ctx.baseDir, path);

    // Allowlist записи (аудит §4.4) — единая точка для мутирующих тулов.
    // Лимит куска (INV-H2): большой content одним вызовом обрывается по
    // completion-лимиту и теряет всё. Режем на чанки через append_file.
    const content = String(args.content ?? "");
    const chunk = validateWriteChunk(path, content);
    if (!chunk.ok) return { success: false, output: chunk.output };

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

    // TOCTOU: путь проверен до хендлера, но симлинк могли подменить. Перед
    // mkdir и записью политику повторяем (INV-9/10, хук исполнителя).
    const unsafeDir = recheckWrite(resolved, ctx);
    if (unsafeDir) return unsafeDir;
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

    const unsafe = recheckWrite(resolved, ctx);
    if (unsafe) return unsafe;
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
