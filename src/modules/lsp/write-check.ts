// Пост-проверка записи: диагностики после `write_file`/`edit_file`, прогрев в
// фоне. Вынесено из `module.ts` (правило 6 AGENTS): это отдельный шов, а модуль
// держал на себе и тул, и хук, и состояние пула.
import { existsSync } from "fs";
import { resolve } from "path";
import type { ToolCall, ToolContext, ToolResult } from "../../tools/types";
import type { CheckResult, LspClient } from "./client";
import { serverKeyFor } from "./client";
import type { LspClientLogger } from "./client-logger";
import { getServerForFile } from "./config";
import { findProjectRoot } from "./project-root";
import type { LspHealth } from "./health";
import type { LspConfig, LspServerConfig } from "./types";
import { isErrorDiagnostic, isWarningDiagnostic } from "./types";
import { formatOneFileDiagnostics } from "./check-report";
import { t } from "../../i18n/index";
import { errMsg } from "../../utils";

/**
 * Бюджет пост-проверки записи. Проверка best-effort: 30-секундный таймаут
 * сервера держал `write_file` полминуты, когда файл вне tsconfig проекта
 * (наблюдалось вживую: write 30.0 с). Тёплый сервер отвечает за миллисекунды.
 */
export const WRITE_CHECK_TIMEOUT_MS = 4000;

/** Всё, что нужно пост-проверке (модуль отдаёт свои инстансы). */
export interface WriteCheckDeps {
  config: LspConfig;
  client: LspClient;
  health: LspHealth;
  logger: LspClientLogger | null;
  /** Структурный лог модуля (app.jsonl, уровень info). */
  log(event: string, meta?: Record<string, unknown>): void;
}

interface CheckTarget {
  fullPath: string;
  serverConfig: LspServerConfig;
  key: string;
  projectRoot: string;
}

/** Пост-проверка после write/edit: только поддержанные файлы, best-effort. */
export async function runWriteCheck(
  deps: WriteCheckDeps,
  ctx: ToolContext,
  call: ToolCall,
  result: ToolResult,
): Promise<void> {
  const target = resolveCheckTarget(deps, ctx, call, result);
  if (!target) return;
  // Холодный сервер НЕ должен блокировать запись: npx-докачка language server
  // занимала 30 с на первую запись (наблюдалось вживую: write 31.5 с).
  // Прогреваем в фоне, проверяем на тёплом соединении (аудит §8.2).
  if (!deps.client.isWarm(target.serverConfig, target.projectRoot)) {
    warmInBackground(deps, target);
    return;
  }
  const started = Date.now();
  try {
    const check = await deps.client.checkFile(
      target.fullPath,
      ctx.baseDir,
      target.serverConfig,
      target.projectRoot,
      WRITE_CHECK_TIMEOUT_MS,
    );
    deps.health.reset(target.key);
    const errors = check.diagnostics.filter(isErrorDiagnostic).length;
    const warnings = check.diagnostics.filter(isWarningDiagnostic).length;
    deps.log(
      `LSP write check: ${target.fullPath} in ${Date.now() - started}ms ` +
        `(${errors} error(s), ${warnings} warning(s)${check.inconclusive ? ", inconclusive" : ""})`,
      {
        op: "write_check",
        server: target.key,
        file: target.fullPath,
        durMs: Date.now() - started,
        errors,
        warnings,
        inconclusive: check.inconclusive,
      },
    );
    appendDiagnostics(result, check, target.fullPath);
  } catch (e) {
    const msg = errMsg(e);
    deps.health.warn(deps.logger, target.fullPath, msg);
    const failure = deps.health.recordFailure(target.key, target.serverConfig, msg);
    deps.log(
      `LSP write check failed: ${target.fullPath} in ${Date.now() - started}ms — ${msg}` +
        (failure.blocked ? ` (next attempt in ${Math.ceil(failure.retryInMs / 1000)}s)` : ""),
      {
        op: "write_check_failed",
        server: target.key,
        file: target.fullPath,
        durMs: Date.now() - started,
        blocked: failure.blocked,
        retryInMs: failure.retryInMs,
        error: msg,
      },
    );
    result.output += failure.blocked
      ? `\n\n[LSP check failed: ${failure.text}\n${t("lsp.blocked_retry", { sec: String(Math.ceil(failure.retryInMs / 1000)) })}]`
      : `\n\n[LSP check failed]: ${failure.text}`;
  }
}

/** Прогрев соединения в фоне (один на сервер+корень). */
function warmInBackground(deps: WriteCheckDeps, target: CheckTarget): void {
  const started = Date.now();
  deps.log(`LSP warm start: ${target.key} (${target.projectRoot})`, {
    op: "warm_start",
    server: target.key,
    root: target.projectRoot,
    trigger: "write",
  });
  deps.health.warmInBackground({
    key: target.key,
    warm: () => deps.client.warmup(target.serverConfig, target.projectRoot),
    onSuccess: () =>
      deps.log(`LSP ready: ${target.key} in ${Date.now() - started}ms`, {
        op: "ready",
        server: target.key,
        root: target.projectRoot,
        durMs: Date.now() - started,
        trigger: "write",
      }),
    onError: (msg) => {
      deps.health.warn(deps.logger, target.fullPath, msg);
      const failure = deps.health.recordFailure(target.key, target.serverConfig, msg);
      deps.log(
        `LSP warm failed: ${target.key} in ${Date.now() - started}ms — ${msg}` +
          (failure.blocked ? ` (next attempt in ${Math.ceil(failure.retryInMs / 1000)}s)` : ""),
        {
          op: "warm_failed",
          server: target.key,
          root: target.projectRoot,
          durMs: Date.now() - started,
          blocked: failure.blocked,
          retryInMs: failure.retryInMs,
          error: msg,
          trigger: "write",
        },
      );
    },
  });
}

/** Файл и сервер для пост-проверки; null — проверять нечего. */
function resolveCheckTarget(
  deps: WriteCheckDeps,
  ctx: ToolContext,
  call: ToolCall,
  result: ToolResult,
): CheckTarget | null {
  if (!deps.config.enabled || !result.success) return null;
  if (call.name !== "write_file" && call.name !== "edit_file") return null;
  const filePath = String(call.arguments.path ?? "");
  if (!filePath) return null;
  const fullPath = resolve(ctx.baseDir, filePath);
  if (!existsSync(fullPath)) return null;
  const serverConfig = getServerForFile(fullPath, deps.config);
  if (!serverConfig) return null;
  const key = serverKeyFor(serverConfig);
  if (deps.health.isDisabled(key)) return null;
  const projectRoot = findProjectRoot(fullPath, ctx.baseDir, serverConfig.workspaceMarkers ?? []);
  return { fullPath, serverConfig, key, projectRoot };
}

/** Дописать диагностики к выводу тула (errors / warnings / inconclusive). */
function appendDiagnostics(result: ToolResult, check: CheckResult, fullPath: string): void {
  const errors = check.diagnostics.filter(isErrorDiagnostic);
  const warnings = check.diagnostics.filter(isWarningDiagnostic);
  if (errors.length > 0) {
    result.output += `\n\n[LSP errors]:\n${formatOneFileDiagnostics(errors, fullPath)}`;
  }
  if (warnings.length > 0) {
    result.output += `\n\n[LSP warnings]:\n${formatOneFileDiagnostics(warnings, fullPath)}`;
  }
  if (check.inconclusive && errors.length === 0 && warnings.length === 0) {
    result.output += t("lsp.check_inconclusive");
  }
}
