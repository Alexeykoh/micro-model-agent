// `lsp_check`: определение тула и хендлер (вынесено из `module.ts`, правило 6).
//
// Проверки LSP шли только после write/edit (плагин модуля), и read-only задача
// «проверь проект на ошибки» получала НОЛЬ фидбэка от компилятора — модель
// сканировала файлы через read_file и не узнавала, компилируется ли код
// (наблюдалось: ses_msvuao0h — задача "проверь на ошибки" без build, без lsp,
// с декларацией успеха). `lsp_check` даёт модели способ спросить статические
// диагностики по требованию.
import { existsSync } from "fs";
import { isPathInScope } from "../security/path-validator";
import { DEFAULT_SECURITY_CONFIG } from "../../config/security";
import { safeResolvePath } from "../../tools/path-utils";
import { t } from "../../i18n/index";
import type { ToolContext, ToolDefinition, ToolResult } from "../../tools/types";
import type { LspClient, LspClientLogger } from "./client";
import type { LspConfig, LspServerConfig } from "./types";
import type { LspHealth } from "./health";
import { collectCheckFiles } from "./check-tool";
import { renderCheckReport, type CheckAccumulator } from "./check-report";
import { runCheckFiles } from "./check-run";

/** Всё, что нужно тулу `lsp_check` (модуль отдаёт свои швы). */
export interface LspCheckToolDeps {
  config: LspConfig;
  client: Pick<LspClient, "isWarm" | "warmup" | "checkFile">;
  health: LspHealth;
  logger: LspClientLogger | null;
  /** Структурная запись модуля (app.jsonl). */
  log(msg: string, meta?: Record<string, unknown>): void;
}

/** Заметка о сбое сервера для `lsp_check`: сама ошибка + пауза, если включилась. */
export function lspFailureNote(
  health: LspHealth,
  key: string,
  serverConfig: LspServerConfig,
  message: string,
  file: string,
): string {
  const failure = health.recordFailure(key, serverConfig, message);
  const retry = failure.blocked
    ? `\n${t("lsp.blocked_retry", { sec: String(Math.ceil(failure.retryInMs / 1000)) })}`
    : "";
  return `[LSP check failed for ${file}: ${failure.text}${retry}]`;
}

/** Проверить файлы через вынесенный прогон (см. `check-run.ts`). */
async function runCheckFilesForTool(
  deps: LspCheckToolDeps,
  files: string[],
  ctx: ToolContext,
): Promise<CheckAccumulator> {
  return runCheckFiles(files, {
    baseDir: ctx.baseDir,
    config: deps.config,
    client: deps.client,
    health: deps.health,
    logger: deps.logger,
    failureNote: (key, serverConfig, message, file) =>
      lspFailureNote(deps.health, key, serverConfig, message, file),
  });
}

async function runCheck(
  deps: LspCheckToolDeps,
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (!deps.config.enabled) {
    return { success: false, output: t("lsp.check_disabled") };
  }
  const path = String(args.path ?? "");
  if (!path) return { success: false, output: t("lsp.check_no_path") };

  const resolved = safeResolvePath(ctx.baseDir, path);
  const securityPaths = ctx.config?.security?.paths || DEFAULT_SECURITY_CONFIG.paths;
  const scopeCheck = isPathInScope(ctx.baseDir, resolved, ctx.scope, securityPaths);
  if (!scopeCheck.allowed) {
    return {
      success: false,
      output: t("file.path_not_allowed", {
        path: `${path} — ${scopeCheck.reason}`,
      }),
    };
  }
  if (!existsSync(resolved)) {
    return { success: false, output: t("lsp.check_notfound", { path }) };
  }

  const files = await collectCheckFiles(resolved, deps.config);
  const acc = await runCheckFilesForTool(deps, files, ctx);
  const report = renderCheckReport(acc);
  deps.log(
    `LSP check ${path}: ${acc.checked}/${files.length} file(s), ` +
      `${acc.errors.length} error(s), ${acc.warnings.length} warning(s), cold ${acc.cold}`,
    {
      op: "check",
      path,
      files: files.length,
      checked: acc.checked,
      errors: acc.errors.length,
      warnings: acc.warnings.length,
      cold: acc.cold,
      inconclusive: acc.inconclusive,
    },
  );
  return report;
}

/** Определение тула `lsp_check`; состояние модуля приходит через `deps`. */
export function createLspCheckToolDefinitions(deps: LspCheckToolDeps): ToolDefinition[] {
  return [
    {
      name: "lsp_check",
      security: { caps: [{ fs: "read" }], pathArgs: ["path"] },
      icon: "🩺",
      description:
        'Run static checks (LSP diagnostics) on a file or directory. For "check for errors" tasks: pass a file to check it, or a directory to check its source files (capped at 15). Returns [LSP errors] / [LSP warnings] for files with a configured LSP server.',
      tags: ["code", "check"],
      alwaysOn: true,
      boundedOutput: true,
      timeoutMs: 90000,
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File or directory to check",
          },
        },
        required: ["path"],
      },
      handler: async (ctx, args) => runCheck(deps, ctx, args),
    },
  ];
}
