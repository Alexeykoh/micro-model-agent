/** Тул точечной правки: exact-match замена, скан, валидация, diff. */
import { readFileSync, writeFileSync } from "fs";
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import { scanContent } from "../modules/security/content-scanner";
import { logFileWrite, logSecurityBlock } from "../modules/security/audit-log";
import { getSessionSecurityConfig } from "../modules/security/session-isolation";
import { generateDiff } from "../ui/diff";
import { safeResolvePath } from "./path-utils";
import { assertWritable, recheckWrite } from "./path-guards";
import { preValidateSyntax, detectImportConflicts } from "./syntax-validator";
import { errMsg } from "../utils";

/**
 * CRLF-толерантная замена: ищет `oldStr` в `content` после нормализации
 * `\r\n` → `\n` у обеих строк, вырезает найденный диапазон из ОРИГИНАЛА
 * (смещения отображаются через карту нормализованных позиций).
 * Возвращает обновлённый контент или null, если якорь не найден.
 * Окончания строк файла сохраняются; вставка подгоняется под доминирующий
 * стиль файла, чтобы не плодить смешанные окончания.
 */
export function spliceNormalized(
  content: string,
  oldStr: string,
  newStr: string,
): string | null {
  const normOld = oldStr.replace(/\r\n/g, "\n");
  // Карта: нормализованная позиция -> позиция в оригинале.
  const norm: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\r" && content[i + 1] === "\n") {
      norm.push("\n");
      map.push(i);
      i++; // пропускаем \n пары — у неё нет своей нормализованной позиции
    } else {
      norm.push(content[i]);
      map.push(i);
    }
  }
  const normContent = norm.join("");
  const idx = normContent.indexOf(normOld);
  if (idx === -1 || normOld.length === 0) return null;
  const startOrig = map[idx];
  const endNorm = idx + normOld.length;
  const endOrig = endNorm < map.length ? map[endNorm] : content.length;

  // Вставка в стиле файла: CRLF-файл + LF-вставка → переводим вставку в CRLF.
  let insert = newStr;
  if (content.includes("\r\n") && !newStr.includes("\r\n") && newStr.includes("\n")) {
    insert = newStr.replace(/\n/g, "\r\n");
  }
  return content.slice(0, startOrig) + insert + content.slice(endOrig);
}

/** Заменяет точный фрагмент в существующем файле (не regex). */
export const editFileTool: ToolDefinition = {
  name: "edit_file",
  security: { caps: [{ fs: "write" }], pathArgs: ["path"] },
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

    // TOCTOU: чтение и запись — две операции, между ними путь мог стать
    // симлинком наружу. Проверяем перед каждой.
    const unsafeRead = recheckWrite(resolved, ctx);
    if (unsafeRead) return unsafeRead;
    let content: string;
    try {
      content = readFileSync(resolved, "utf-8");
    } catch (err) {
      return {
        success: false,
        output: t("file.read_failed", { path, error: errMsg(err) }),
      };
    }

    // Замена через функцию — иначе newStr трактуется как шаблон и `$&`, `$1`
    // молча испортят содержимое файла.
    let updated: string;
    if (content.includes(oldStr)) {
      updated = content.replace(oldStr, () => newStr);
    } else {
      // CRLF-фолбэк (ses_mup6p61q): модель шлёт LF-якоря в CRLF-файл (Windows
      // checkout) — точный матч не срабатывает никогда. Матчим на
      // нормализованных окончаниях, вырезаем по отображённым смещениям
      // оригинала, окончания строк файла не трогаем.
      const spliced = spliceNormalized(content, oldStr, newStr);
      if (!spliced) {
        return {
          success: false,
          output: t("file.string_not_found", { str: oldStr, path }),
        };
      }
      updated = spliced;
    }

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

    const unsafeWrite = recheckWrite(resolved, ctx);
    if (unsafeWrite) return unsafeWrite;
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
