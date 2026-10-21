// Модуль LSP: автопроверка после write/edit, тул lsp_check, отключение мёртвых серверов.
import type { AgentModule } from "../types";
import type { AgentPlugin } from "../types";
import type { ToolDefinition, ToolContext, ToolCall, ToolResult } from "../../tools/types";
import { existsSync } from "fs";
import { relative, resolve } from "path";
import { LspClient, serverKeyFor, type LspClientLogger, type CheckResult } from "./client";
import { getServerForFile, getServerForLanguage, DEFAULT_LSP_CONFIG } from "./config";
import type { LspSymbolLocation } from "./symbols";
import { findProjectRoot } from "./project-root";
import { isPathInScope } from "../security/path-validator";
import { DEFAULT_SECURITY_CONFIG } from "../../config/security";
import { toForwardSlash } from "../../tools/path-utils";
import { safeResolvePath } from "../../tools/path-utils";
import { t } from "../../i18n/index";
import type { LspConfig, LspDiagnostic, LspServerConfig } from "./types";
import { isErrorDiagnostic, isWarningDiagnostic } from "./types";
import { severityLabel, collectCheckFiles, } from "./check-tool";
import { renderCheckReport, type CheckAccumulator } from "./check-report";
import {
  diagnoseLspServers,
  classifyLspError,
  type LspDiagnoseDeps,
  type LspFailureReason,
} from "./diagnose";
import { errMsg } from "../../utils";
import { join } from "path";

/**
 * Подряд идущих падений LSP до отключения сервера на сессию. Мёртвый сервер
 * (не стоит, упала npx-автоустановка, нет пути) иначе спамит `[LSP check failed]`
 * на КАЖДУЮ запись, приучая модель игнорировать сигнал целиком (наблюдалось:
 * ses_mst2r0r5 — LSP мёртв всю сессию, модель не реагировала). После порога —
 * одно громкое сообщение и тишина по этому серверу: таймаут CSS не должен
 * ронять проверки TypeScript.
 */
const MAX_CONSECUTIVE_LSP_FAILURES = 3;

/**
 * Диагностики резолва модулей, бессмысленные без type-окружения. В голом
 * каталоге (без tsconfig.json / node_modules) TS-сервер рапортует
 * `Cannot find module 'fs'` и `Cannot find name '__dirname'` на валидный
 * Node-код — модель бросает рабочий подход из-за фантомных ошибок (наблюдалось
 * ses_mtho2oab: LSP-"ошибки" столкнули модель с планового .ts на .js и в
 * спираль plan-drift). Душатся с явной пометкой inconclusive, если рядом с
 * корнем проекта нет type-окружения.
 */
const TYPE_ENV_DIAG_PATTERN =
  /Cannot find module ['"][^'"]+['"] or its corresponding type declarations|Cannot find name '(__dirname|__filename|require|process|Buffer|console)'|Do you need to install type definitions/;

/** Ключи actionable-подсказок по классу причины сбоя LSP (одна строка модели). */
const LSP_HINT_KEYS: Partial<Record<LspFailureReason, string>> = {
  "binary-missing": "lsp.hint_binary_missing",
  offline: "lsp.hint_offline",
  network: "lsp.hint_network",
  timeout: "lsp.hint_timeout",
  "spawn-failed": "lsp.hint_spawn",
};

/** Подсказка под `[LSP check failed]` (пусто, если класса с действием нет). */
function failureHint(message: string, npxFallback: boolean): string {
  const key = LSP_HINT_KEYS[classifyLspError(message, { npxFallback })];
  return key ? `\n${t(key)}` : "";
}

function hasTypeEnvironment(projectRoot: string): boolean {
  return (
    existsSync(join(projectRoot, "tsconfig.json")) ||
    existsSync(join(projectRoot, "jsconfig.json")) ||
    existsSync(join(projectRoot, "node_modules"))
  );
}

/** Модуль LSP: пост-проверки записи, тул lsp_check, учёт мёртвых серверов. */
export class LspModule implements AgentModule {
  name = "lsp";
  private config: LspConfig;
  private client: LspClient;
  private failuresByServer = new Map<string, number>();
  private disabledServers = new Set<string>();
  private logger: LspClientLogger | null = null;

  constructor(config?: Partial<LspConfig>, client?: LspClient, logger?: LspClientLogger) {
    this.config = { ...DEFAULT_LSP_CONFIG, ...config };
    this.client = client ?? new LspClient();
    this.client.setOffline(this.config.offline);
    this.logger = logger ?? null;
    this.client.setLogger(this.logger);
  }

  /** Обновить логгер (напр. после смены сессии). */
  setLogger(logger: LspClientLogger | null): void {
    this.logger = logger;
    this.client.setLogger(logger);
  }

  /** Глобальный тумблер LSP (живьём; плагин читает `this.config.enabled`). */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    this.client.setOffline(this.config.offline);
  }

  /** Офлайн-режим живьём: не использовать npx (env `MMA_LSP_OFFLINE` сильнее). */
  setOffline(offline: boolean): void {
    this.config.offline = offline;
    this.client.setOffline(offline);
  }

  /** Текущие глобальные флаги для UI (`GET /api/lsp/doctor`, вкладка LSP). */
  getFlags(): { enabled: boolean; offline: boolean } {
    return { enabled: this.config.enabled !== false, offline: this.config.offline === true };
  }

  /**
   * Поиск символов по имени через LSP `workspace/symbol` (для карты проекта).
   * Best-effort: без сервера для языка / при отключённом LSP / ошибке — пустой
   * список, чтобы вызывающий (IndexerModule) откатился на собственный индекс.
   */
  async workspaceSymbol(
    query: string,
    baseDir: string,
    language: string,
  ): Promise<LspSymbolLocation[]> {
    if (this.config.enabled === false || !query.trim()) return [];
    const server = getServerForLanguage(language, this.config);
    if (!server) return [];
    const projectRoot = findProjectRoot(baseDir, baseDir, server.workspaceMarkers ?? []);
    try {
      return await this.client.workspaceSymbol(query, server, projectRoot, server.timeout);
    } catch (e) {
      this.logger?.debug(`LSP workspace/symbol failed: ${errMsg(e)}`);
      return [];
    }
  }

  /** Сбросить отключённые серверы (напр. после /lsp restart). */
  resetDisabledServers(): void {
    this.failuresByServer.clear();
    this.disabledServers.clear();
  }

  /**
   * Закрыть все тёплые соединения (конец сессии). Без этого серверы
   * переживают ход: пул живёт до закрытия процесса.
   */
  async close(): Promise<void> {
    await this.client.close();
  }

  /** Сколько LSP-серверов сейчас живо в пуле (для `/lsp status`). */
  liveServers(): number {
    return this.client.liveConnections();
  }

  /** Сводка пула: живые соединения, перезапуски, reap. */
  poolStats(): { live: number; restarts: number; reaped: number } {
    return this.client.stats();
  }

  /** Список отключённых ключей серверов. */
  getDisabledServers(): string[] {
    return Array.from(this.disabledServers);
  }

  /** Счётчики падений по серверам. */
  getFailureCounts(): Map<string, number> {
    return new Map(this.failuresByServer);
  }

  /**
   * Структурная диагностика серверов проекта (для `/lsp doctor`): применимость,
   * резолв запуска, реальная проба и класс причины. По умолчанию использует
   * собственный клиент и логгер модуля.
   */
  diagnose(baseDir: string, deps: LspDiagnoseDeps = {}) {
    return diagnoseLspServers(this.config, baseDir, {
      ...deps,
      client: deps.client ?? this.client,
      logger: deps.logger ?? this.logger ?? undefined,
    });
  }

  /** Тест-хук: отключал ли модуль какой-то LSP-сервер на сессии. */
  isLspDisabled(): boolean {
    return this.disabledServers.size > 0;
  }

  /** Тест-хук: отключён ли сервер (ключ из конфига). */
  isServerDisabled(key: string): boolean {
    return this.disabledServers.has(key);
  }

  getPlugin(): AgentPlugin {
    return {
      name: "lsp-check",
      priority: 15,
      onSessionEnd: () => {
        // Мёртвые серверы в конце сессии — утечка процесса (npx → node →
        // tsserver) на весь срок жизни хоста.
        void this.client.close();
      },
      onAfterTool: (_ctx, call, result) => this.checkAfterWrite(_ctx, call, result),
    };
  }

  /** Пост-проверка после write/edit: только поддержанные файлы, best-effort. */
  private async checkAfterWrite(
    ctx: ToolContext,
    call: ToolCall,
    result: ToolResult,
  ): Promise<void> {
    const target = this.resolveCheckTarget(ctx, call, result);
    if (!target) return;
    try {
      const check = await this.client.checkFile(
        target.fullPath,
        ctx.baseDir,
        target.serverConfig,
        target.projectRoot,
      );
      this.failuresByServer.set(target.key, 0);
      this.appendDiagnostics(result, check, target.fullPath);
    } catch (e) {
      const msg = errMsg(e);
      this.warnFailure(ctx, target.fullPath, msg);
      const failure = this.recordFailure(target.key, target.serverConfig, msg);
      result.output += failure.disabled
        ? `\n\n[LSP disabled: ${failure.text}]`
        : `\n\n[LSP check failed]: ${failure.text}`;
    }
  }

  /** Файл и сервер для пост-проверки; null — проверять нечего. */
  private resolveCheckTarget(
    ctx: ToolContext,
    call: ToolCall,
    result: ToolResult,
  ): { fullPath: string; serverConfig: LspServerConfig; key: string; projectRoot: string } | null {
    if (!this.config.enabled || !result.success) return null;
    if (call.name !== "write_file" && call.name !== "edit_file") return null;
    const filePath = String(call.arguments.path ?? "");
    if (!filePath) return null;
    const fullPath = resolve(ctx.baseDir, filePath);
    if (!existsSync(fullPath)) return null;
    const serverConfig = getServerForFile(fullPath, this.config);
    if (!serverConfig) return null;
    const key = serverKeyFor(serverConfig);
    if (this.disabledServers.has(key)) return null;
    const projectRoot = findProjectRoot(fullPath, ctx.baseDir, serverConfig.workspaceMarkers ?? []);
    return { fullPath, serverConfig, key, projectRoot };
  }

  /** Дописать диагностики к выводу тула (errors / warnings / inconclusive). */
  private appendDiagnostics(result: ToolResult, check: CheckResult, fullPath: string): void {
    const errors = check.diagnostics.filter(isErrorDiagnostic);
    const warnings = check.diagnostics.filter(isWarningDiagnostic);
    if (errors.length > 0) {
      result.output += `\n\n[LSP errors]:\n${formatDiagnostics(errors, fullPath)}`;
    }
    if (warnings.length > 0) {
      result.output += `\n\n[LSP warnings]:\n${formatDiagnostics(warnings, fullPath)}`;
    }
    if (check.inconclusive && errors.length === 0 && warnings.length === 0) {
      result.output += t("lsp.check_inconclusive");
    }
  }

  /** Учесть падение сервера. После порога сервер отключается на сессию. */
  private recordFailure(
    key: string,
    serverConfig: LspServerConfig,
    message: string,
  ): { disabled: boolean; text: string } {
    const failures = (this.failuresByServer.get(key) ?? 0) + 1;
    this.failuresByServer.set(key, failures);
    if (failures >= MAX_CONSECUTIVE_LSP_FAILURES) {
      // Одно громкое actionable-сообщение, дальше — без шума на каждую запись
      // до конца сессии. Модель не должна учиться игнорить LSP.
      this.disabledServers.add(key);
      return { disabled: true, text: t("lsp.unavailable") };
    }
    return {
      disabled: false,
      text: `${message}${failureHint(message, serverConfig.command === "npx")}`,
    };
  }

  private warnFailure(ctx: ToolContext, filePath: string, message: string): void {
    try {
      ctx.logger?.warn(`LSP check failed for ${filePath}: ${message}`);
    } catch {
      // Падающий логгер не должен ломать путь проверки.
    }
  }

  /**
   * Тул диагностики по требованию. Проверки LSP шли только после write/edit
   * (плагин выше), и read-only задача «проверь проект на ошибки» получала
   * НОЛЬ фидбэка от компилятора — модель сканировала файлы через read_file и
   * не узнавала, компилируется ли код (наблюдалось: ses_msvuao0h — задача
   * "проверь на ошибки" без build, без lsp, с декларацией успеха). `lsp_check`
   * даёт модели способ спросить статические диагностики по требованию.
   */
  getToolDefinitions(): ToolDefinition[] {
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
        handler: async (ctx, args) => this.runCheck(ctx, args),
      },
    ];
  }

  private async runCheck(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.config.enabled) {
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

    const files = await collectCheckFiles(resolved, this.config);
    const acc = await this.checkFiles(files, ctx);
    return renderCheckReport(acc);
  }

  /** Проверить набор файлов, накопив диагностики и заметки о сбоях. */
  private async checkFiles(files: string[], ctx: ToolContext): Promise<CheckAccumulator> {
    const acc: CheckAccumulator = {
      baseDir: ctx.baseDir,
      errors: [],
      warnings: [],
      notes: [],
      checkedFiles: [],
      checked: 0,
      inconclusive: 0,
      suppressed: 0,
    };
    for (const file of files) {
      const serverConfig = getServerForFile(file, this.config);
      if (!serverConfig) continue;
      const key = serverKeyFor(serverConfig);
      if (this.disabledServers.has(key)) continue;
      const projectRoot = findProjectRoot(file, ctx.baseDir, serverConfig.workspaceMarkers ?? []);
      try {
        const result = await this.client.checkFile(file, ctx.baseDir, serverConfig, projectRoot);
        this.failuresByServer.set(key, 0);
        this.collectDiagnostics(acc, file, ctx.baseDir, result, projectRoot);
      } catch (e) {
        this.warnFailure(ctx, file, errMsg(e));
        acc.notes.push(this.failureNote(key, serverConfig, errMsg(e), file));
      }
    }
    return acc;
  }

  /** Сложить диагностики одного файла в аккумулятор (с type-env фильтром). */
  private collectDiagnostics(
    acc: CheckAccumulator,
    file: string,
    baseDir: string,
    result: CheckResult,
    projectRoot: string,
  ): void {
    acc.checked++;
    acc.checkedFiles.push(toForwardSlash(relative(baseDir, file)));
    let diags = result.diagnostics;
    if (!hasTypeEnvironment(projectRoot)) {
      diags = diags.filter((d) => {
        if (TYPE_ENV_DIAG_PATTERN.test(d.message)) {
          acc.suppressed++;
          return false;
        }
        return true;
      });
    }
    if (result.inconclusive) acc.inconclusive++;
    for (const d of diags) {
      if (isErrorDiagnostic(d)) acc.errors.push({ file, diag: d });
      else if (isWarningDiagnostic(d)) acc.warnings.push({ file, diag: d });
    }
  }


  /** Заметка о сбое сервера для `lsp_check` (disabled или failed+hint). */
  private failureNote(
    key: string,
    serverConfig: LspServerConfig,
    message: string,
    file: string,
  ): string {
    const failure = this.recordFailure(key, serverConfig, message);
    return failure.disabled
      ? `[LSP disabled: ${failure.text}]`
      : `[LSP check failed for ${file}: ${failure.text}]`;
  }
}

function formatDiagnostics(diagnostics: LspDiagnostic[], filePath: string): string {
  const filename = toForwardSlash(filePath).split("/").pop() ?? filePath;
  return diagnostics
    .slice(0, 5)
    .map((d) => {
      const line = d.range.start.line + 1;
      const col = d.range.start.character + 1;
      const sev = severityLabel(d);
      return `  ${filename}(${line},${col}): ${sev}: ${d.message}`;
    })
    .join("\n");
}
