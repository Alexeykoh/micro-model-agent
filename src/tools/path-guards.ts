// Общие гварды путей для тулов: workdir `bash` и allowlist записи.
// Живут в `src/tools/`, потому что это шов тулов, а не политика модуля.
import { platform } from "os";
import { resolve } from "path";
import { t } from "../i18n/index";
import { validateWorkdir } from "../modules/security/path-validator";
import { logSecurityBlock } from "../modules/security/audit-log";
import { safeResolvePath } from "./path-utils";
import type { ToolContext, ToolResult } from "./types";

/**
 * Allowlist записи (`ctx.writePathAllowlist`) — единая точка для всех
 * мутирующих файловых тулов (аудит §4.4). Раньше проверка жила только в
 * `write_file`/`append_file`/`edit_file`, и `delete_file`/`move_file`/
 * `create_dir` её обходили.
 *
 * @returns заблокированный результат или `undefined`, если запись разрешена.
 */
export function assertWritable(path: string, ctx: ToolContext): ToolResult | undefined {
  if (!ctx.writePathAllowlist) return undefined;
  const resolved = safeResolvePath(ctx.baseDir, path);
  const ok = ctx.writePathAllowlist.some(
    (p) => resolve(p).toLowerCase() === resolved.toLowerCase(),
  );
  if (ok) return undefined;
  return {
    success: false,
    output: t("file.path_not_allowed", {
      path: `${path} — ${t("onboarding.write_restricted")}`,
      reason: t("onboarding.write_restricted"),
    }),
  };
}

/**
 * Повторная проверка пути перед файловой операцией (TOCTOU): симлинк могли
 * подменить после первичного enforcement. Политику даёт `ToolExecutor` через
 * `ctx.pathGuard`; хендлер её не реализует.
 *
 * @param path абсолютный путь, с которым вот-вот будет операция.
 * @returns заблокированный результат или `undefined`.
 */
export function recheckWrite(path: string, ctx: ToolContext): ToolResult | undefined {
  return ctx.pathGuard?.recheck(path);
}

/**
 * POSIX-workdir на Windows: cmd.exe не понимает "/tmp"/"/Users/…" — это
 * почти всегда путаница ОС у модели. Даём корректирующий хинт вместо
 * непонятной ошибки spawn.
 *
 * @returns текст хинта или `undefined`, если хинт не нужен.
 */
export function posixWorkdirHint(workdir: string, baseDir: string): string | undefined {
  if (platform() !== "win32" || !/^[~/]/.test(workdir)) return undefined;
  return t("bash.posix_workdir_hint", { workdir, baseDir });
}

/**
 * echo/printf-редирект в файл ненадёжен в cmd.exe (одиночные кавычки не
 * группируют, многострочник рвётся, вложенные двойные кавычки ломают
 * команду). Вести на write_file — с ним файлы корректны всегда.
 *
 * @returns текст хинта или `undefined`, если редирект не найден.
 */
export function echoWriteHint(echoWrite: string | null | undefined): string | undefined {
  if (!echoWrite) return undefined;
  return t("bash.echo_write_blocked", { path: echoWrite });
}

/**
 * Workdir `bash` (аудит §4.1): рабочий каталог обязан лежать внутри
 * `baseDir` и — для субагента — внутри его скоупа. Без проверки модель одной
 * командой уходила за пределы проекта (`workdir: C:\Users\…`).
 *
 * @returns заблокированный результат или `undefined`, если можно исполнять.
 */
export function assertWorkdirAllowed(ctx: ToolContext, workdir: string): ToolResult | undefined {
  const check = validateWorkdir(ctx.baseDir, workdir, ctx.scope);
  if (check.allowed) return undefined;
  logSecurityBlock(
    ctx.sessionId,
    "bash_command",
    check.reason || "Workdir is not allowed",
    `workdir: ${workdir}`,
  );
  return {
    success: false,
    output: t("bash.workdir_blocked", {
      reason: check.reason || "",
      baseDir: ctx.baseDir,
    }),
  };
}
