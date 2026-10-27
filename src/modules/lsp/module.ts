// Модуль LSP: автопроверка после write/edit, тул lsp_check, отключение мёртвых серверов.
import type { AgentModule } from "../types";
import type { AgentPlugin } from "../types";
import type { ToolDefinition, ToolContext, ToolCall, ToolResult } from "../../tools/types";
import { existsSync } from "fs";
import { resolve } from "path";
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
import { runCheckFiles } from "./check-run";
import { diagnoseLspServers, type LspDiagnoseDeps } from "./diagnose";
import { errMsg } from "../../utils";
import { LspHealth } from "./health";
/**
 * Диагностики резолва модулей, бессмысленные без type-окружения. В голом
 * каталоге (без tsconfig.json / node_modules) TS-сервер рапортует
 * `Cannot find module 'fs'` на валидный Node-код — модель бросает рабочий
 * подход из-за фантомных ошибок. Душатся с пометкой inconclusive.
 */

/**
 * Бюджет пост-проверки записи. Проверка best-effort: 30-секундный таймаут
 * сервера держал `write_file` полминуты, когда файл вне tsconfig проекта
 * (наблюдалось вживую: write 30.0 с). Тёплый сервер отвечает за миллисекунды.
 */
const WRITE_CHECK_TIMEOUT_MS = 4000;

/** Модуль LSP: пост-проверки записи, тул lsp_check, учёт мёртвых серверов. */
export class LspModule implements AgentModule {
  name = "lsp";
  private config: LspConfig;
  private client: LspClient;
  /** Здоровье серверов: падения, отключение после порога, прогрев в фоне. */
  private health = new LspHealth();
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
    this.health.resetAll();
    
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
    return this.health.disabledKeys();
  }

  /** Счётчики падений по серверам. */
  getFailureCounts(): Map<string, number> {
    return this.health.counts();
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
    return this.health.disabledKeys().length > 0;
  }

  /** Тест-хук: отключён ли сервер (ключ из конфига). */
  isServerDisabled(key: string): boolean {
    return this.health.isDisabled(key);
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
    // Холодный сервер НЕ должен блокировать запись: npx-докачка language server
    // занимала 30 с на первую запись (наблюдалось вживую: write 31.5 с).
    // Прогреваем в фоне, проверяем на тёплом соединении — следующая запись
    // получит диагностики без задержки (аудит §8.2).
    if (!this.client.isWarm(target.serverConfig, target.projectRoot)) {
      this.warmInBackground(target);
      return;
    }
    try {
      const check = await this.client.checkFile(
        target.fullPath,
        ctx.baseDir,
        target.serverConfig,
        target.projectRoot,
        WRITE_CHECK_TIMEOUT_MS,
      );
      this.health.reset(target.key);
      this.appendDiagnostics(result, check, target.fullPath);
    } catch (e) {
      const msg = errMsg(e);
      this.health.warn(this.logger, target.fullPath, msg);
      const failure = this.health.recordFailure(target.key, target.serverConfig, msg);
      result.output += failure.disabled
        ? `\n\n[LSP disabled: ${failure.text}]`
        : `\n\n[LSP check failed]: ${failure.text}`;
    }
  }

  /**
   * Прогрев соединения в фоне (один на сервер+корень). Падения считает
   * `LspHealth`: после порога сервер отключается на сессию, и повторов npx
   * больше нет.
   */
  private warmInBackground(
    target: { serverConfig: LspServerConfig; key: string; projectRoot: string; fullPath: string },
  ): void {
    this.health.warmInBackground({
      key: target.key,
      warm: () => this.client.warmup(target.serverConfig, target.projectRoot),
      onError: (msg) => {
        this.health.warn(this.logger, target.fullPath, msg);
        this.health.recordFailure(target.key, target.serverConfig, msg);
      },
    });
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
    if (this.health.isDisabled(key)) return null;
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
  /** Проверить файлы через вынесенный прогон (см. `check-run.ts`). */
  private async checkFiles(files: string[], ctx: ToolContext): Promise<CheckAccumulator> {
    return runCheckFiles(files, {
      baseDir: ctx.baseDir,
      config: this.config,
      client: this.client,
      health: this.health,
      logger: this.logger,
      failureNote: (key, serverConfig, message, file) =>
        this.failureNote(key, serverConfig, message, file),
    });
  }

  /** Заметка о сбое сервера для `lsp_check` (disabled или failed+hint). */
  private failureNote(
    key: string,
    serverConfig: LspServerConfig,
    message: string,
    file: string,
  ): string {
    const failure = this.health.recordFailure(key, serverConfig, message);
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
