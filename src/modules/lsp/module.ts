// Модуль LSP: автопроверка после write/edit, тул lsp_check, отключение мёртвых серверов.
import type { AgentModule } from "../types";
import type { AgentPlugin } from "../types";
import type { ToolDefinition, ToolCall, ToolContext, ToolResult } from "../../tools/types";
import { LspClient, type LspClientLogger } from "./client";
import { getServerForLanguage, DEFAULT_LSP_CONFIG } from "./config";
import type { LspSymbolLocation } from "./symbols";
import { findProjectRoot } from "./project-root";
import { isPathInScope } from "../security/path-validator";
import { DEFAULT_SECURITY_CONFIG } from "../../config/security";
import { safeResolvePath } from "../../tools/path-utils";
import { t } from "../../i18n/index";
import type { LspConfig, LspServerConfig } from "./types";
import { collectCheckFiles } from "./check-tool";
import { renderCheckReport, type CheckAccumulator } from "./check-report";
import { runWebCheck, type WebCheckDeps } from "./web-check";
import { runChangedChecks } from "./changed-check";
import { runCheckFiles } from "./check-run";
import { runWriteCheck, type WriteCheckDeps } from "./write-check";
import { warmProjectServers } from "./warmup";
import { diagnoseLspServers, type LspDiagnoseDeps } from "./diagnose";
import { errMsg } from "../../utils";
import { LspHealth } from "./health";
import { existsSync } from "fs";
/**
 * Диагностики резолва модулей, бессмысленные без type-окружения. В голом
 * каталоге (без tsconfig.json / node_modules) TS-сервер рапортует
 * `Cannot find module 'fs'` на валидный Node-код — модель бросает рабочий
 * подход из-за фантомных ошибок. Душатся с пометкой inconclusive.
 */

/** Модуль LSP: пост-проверки записи, тул lsp_check, учёт состояния серверов. */
export class LspModule implements AgentModule {
  name = "lsp";
  private config: LspConfig;
  private client: LspClient;
  /** Здоровье серверов: падения, пауза восстановления, прогрев в фоне. */
  private health = new LspHealth();
  private logger: LspClientLogger | null = null;
  /** Корень проекта для фонового прогрева на старте сессии. */
  private readonly baseDir: string;
  /** Прогрев в фоне уже запущен (один на процесс/сессию). */
  private warmStarted = false;

  constructor(
    config?: Partial<LspConfig>,
    client?: LspClient,
    logger?: LspClientLogger,
    baseDir?: string,
  ) {
    this.config = { ...DEFAULT_LSP_CONFIG, ...config };
    this.client = client ?? new LspClient();
    this.client.setOffline(this.config.offline);
    this.logger = logger ?? null;
    this.client.setLogger(this.logger);
    this.baseDir = baseDir ?? process.cwd();
  }

  setLogger(logger: LspClientLogger | null): void {
    this.logger = logger;
    this.client.setLogger(logger);
  }

  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    this.client.setOffline(this.config.offline);
  }

  setOffline(offline: boolean): void {
    this.config.offline = offline;
    this.client.setOffline(offline);
  }

  getFlags(): { enabled: boolean; offline: boolean } {
    return { enabled: this.config.enabled !== false, offline: this.config.offline === true };
  }

  /** Поиск символов (`workspace/symbol`); без сервера — пустой список. */
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
      this.log(`LSP symbol failed: ${errMsg(e)}`, { op: "symbol", error: errMsg(e) });
      return [];
    }
  }

  /** Сбросить паузы восстановления (напр. после /lsp restart). */
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

  /** Что именно поднято: сервер, корень проекта, возраст (для `/lsp status`). */
  poolStates(): Array<{ key: string; root: string; ageMs: number }> {
    return this.client.liveStates();
  }

  /** Сводка пула: живые соединения, перезапуски, reap. */
  poolStats(): { live: number; restarts: number; reaped: number } {
    return this.client.stats();
  }

  /** Серверы на паузе восстановления: ключ и сколько ждать (для `/lsp status`). */
  getBlockedServers(): Array<{ key: string; retryInMs: number }> {
    return this.health.blocked();
  }

  /** Список ключей серверов на паузе (совместимость с `/lsp status`). */
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

  /** Тест-хук: есть ли серверы на паузе восстановления. */
  isLspDisabled(): boolean {
    return this.health.disabledKeys().length > 0;
  }

  /** Тест-хук: стоит ли сервер на паузе восстановления. */
  isServerDisabled(key: string): boolean {
    return this.health.isDisabled(key);
  }

  /** Прогрев применимых серверов проекта в фоне (старт сессии). */
  warmProject(): void {
    if (this.warmStarted) return;
    this.warmStarted = true;
    void warmProjectServers({
      config: this.config,
      baseDir: this.baseDir,
      client: this.client,
      health: this.health,
      logger: this.logger,
      log: (msg, meta) => this.log(msg, meta),
      scanTimeoutMs: 5000,
    });
  }

  getPlugin(): AgentPlugin {
    return {
      name: "lsp-check",
      description: "language-server diagnostics after edits",
      priority: 15,
      // Серверы поднимаются заранее: первый lsp_check/запись не платит холодный
      // старт и не упирается в бюджет ожидания.
      onSessionStart: () => this.warmProject(),
      onSessionEnd: () => {
        void this.client.close();
      },
      onAfterTool: (ctx, call, result) => this.checkAfterWrite(ctx, call, result),
    };
  }

  /** Пост-проверка записи (вынесена в `write-check.ts`). */
  private checkAfterWrite(ctx: ToolContext, call: ToolCall, result: ToolResult): Promise<void> {
    return runWriteCheck(this.writeDeps(), ctx, call, result);
  }

  private writeDeps(): WriteCheckDeps {
    return {
      config: this.config,
      client: this.client,
      health: this.health,
      logger: this.logger,
      log: (msg, meta) => this.log(msg, meta),
    };
  }

  /** Структурная запись в app.jsonl (info): видно, что и сколько длилось. */
  private log(msg: string, meta?: Record<string, unknown>): void {
    // DEBT(lsp-session-log-events): события LSP идут в app.jsonl, но не в
    // session.jsonl (для сессионного журнала нужен отдельный тип события).
    try {
      this.logger?.info(msg, meta);
    } catch {
      /* логгер — не часть контракта */
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
    const report = renderCheckReport(acc);
    this.log(
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

  /** Заметка о сбое сервера для `lsp_check`: сама ошибка + пауза, если включилась. */
  private failureNote(
    key: string,
    serverConfig: LspServerConfig,
    message: string,
    file: string,
  ): string {
    const failure = this.health.recordFailure(key, serverConfig, message);
    const retry = failure.blocked
      ? `\n${t("lsp.blocked_retry", { sec: String(Math.ceil(failure.retryInMs / 1000)) })}`
      : "";
    return `[LSP check failed for ${file}: ${failure.text}${retry}]`;
  }

  /** Веб-панель: структурная диагностика одного файла (jail + данные, не текст). */
  checkFileForWeb(relPath: string, baseDir: string) {
    return runWebCheck(relPath, this.webDeps(baseDir));
  }

  /** Веб-панель: изменённые файлы рабочего дерева (bounded очередь). */
  checkChangedForWeb(baseDir: string) {
    return runChangedChecks(this.webDeps(baseDir));
  }

  private webDeps(baseDir: string): WebCheckDeps {
    return {
      baseDir,
      config: this.config,
      client: this.client,
      health: this.health,
      logger: this.logger,
      failureNote: (key, serverConfig, message, file) =>
        this.failureNote(key, serverConfig, message, file),
    };
  }
}
