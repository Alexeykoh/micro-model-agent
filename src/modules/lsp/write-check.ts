// Пост-проверка записи: диагностики после `write_file`/`edit_file`, прогрев в
// фоне. Вынесено из `module.ts` (правило 6 AGENTS): это отдельный шов, а модуль
// держал на себе и тул, и хук, и состояние пула.
import { existsSync, readFileSync } from "fs";
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

/** Ошибки вида «модуль не найден» по alias-путям (@/, ~/, ./) на холодном индексе. */
const ALIAS_MODULE_NOT_FOUND_PATTERN =
  /Cannot find module ['"](?:@\/|~\/|\.\/|\.\.\/)[^'"]+['"] or its corresponding type declarations/;

/** Алиас-ошибки резолва не блокируют запись (INV-H4): индекс ещё холодный. */
export function isAliasModuleError(message: string): boolean {
  return ALIAS_MODULE_NOT_FOUND_PATTERN.test(message);
}

/**
 * Pre-write gate: check the DRAFT through a warm LSP before the file changes.
 * Returns a block message for `onBeforeTool`, or null to allow the write.
 * Cold servers are warmed in the background and the write is allowed (fail-open,
 * same rule as the post-write check: a 30 s cold start must not block a turn).
 */
export async function runPreWriteCheck(
  deps: WriteCheckDeps,
  ctx: ToolContext,
  call: ToolCall,
): Promise<string | null> {
  if (!deps.config.enabled) return null;
  if (call.name !== "write_file" && call.name !== "edit_file") return null;
  const filePath = String(call.arguments.path ?? "");
  if (!filePath) return null;
  const fullPath = resolve(ctx.baseDir, filePath);
  const serverConfig = getServerForFile(fullPath, deps.config);
  if (!serverConfig) return null;
  const key = serverKeyFor(serverConfig);
  if (deps.health.isDisabled(key)) return null;
  const projectRoot = findProjectRoot(fullPath, ctx.baseDir, serverConfig.workspaceMarkers ?? []);
  const target: CheckTarget = { fullPath, serverConfig, key, projectRoot };
  if (!deps.client.isWarm(serverConfig, projectRoot)) {
    warmInBackground(deps, target);
    return null;
  }
  const draft = draftContent(call, fullPath);
  if (draft === null) return null;
  const started = Date.now();
  try {
    const check = await deps.client.checkContent(
      fullPath,
      draft,
      serverConfig,
      projectRoot,
      WRITE_CHECK_TIMEOUT_MS,
    );
    deps.health.reset(key);
    const errors = check.diagnostics.filter(isErrorDiagnostic);
    // INV-H4: ошибки резолва alias-модулей на холодном индексе не настоящие —
    // разрешаем запись как unverified, верификация после прогрева индекса.
    const aliasErrors = errors.filter((d) => isAliasModuleError(d.message));
    const hardErrors = errors.filter((d) => !isAliasModuleError(d.message));
    deps.log(
      `LSP pre-write check: ${fullPath} in ${Date.now() - started}ms (${errors.length} error(s)` +
        `${aliasErrors.length > 0 ? `, ${aliasErrors.length} unverified` : ""})`,
      { op: "pre_write_check", server: key, file: fullPath, durMs: Date.now() - started, errors: errors.length },
    );
    if (hardErrors.length === 0) return null;
    return t("lsp.draft_blocked", {
      path: filePath,
      problems: formatOneFileDiagnostics(hardErrors, fullPath),
    });
  } catch (e) {
    deps.health.warn(deps.logger, fullPath, errMsg(e));
    deps.log(`LSP pre-write check failed: ${fullPath} - ${errMsg(e)}`, {
      op: "pre_write_check_failed",
      server: key,
      file: fullPath,
      error: errMsg(e),
    });
    return null;
  }
}

/** The content the tool is about to write; null when it cannot be reconstructed. */
function draftContent(call: ToolCall, fullPath: string): string | null {
  if (call.name === "write_file") {
    return typeof call.arguments.content === "string" ? call.arguments.content : null;
  }
  const oldStr = typeof call.arguments.old === "string" ? call.arguments.old : "";
  const newStr = typeof call.arguments.new === "string" ? call.arguments.new : "";
  if (!oldStr || !existsSync(fullPath)) return null;
  try {
    const current = readFileSync(fullPath, "utf-8");
    const norm = current.replace(/\r\n/g, "\n");
    const idx = norm.indexOf(oldStr.replace(/\r\n/g, "\n"));
    if (idx === -1) return null;
    return norm.slice(0, idx) + newStr + norm.slice(idx + oldStr.replace(/\r\n/g, "\n").length);
  } catch {
    return null;
  }
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
