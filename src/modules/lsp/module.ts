// Модуль LSP: автопроверка после write/edit, тул lsp_check, отключение мёртвых серверов.
import type { AgentModule } from "../types";
import type { AgentPlugin } from "../types";
import type { ToolDefinition, ToolCall, ToolContext, ToolResult } from "../../tools/types";
import { LspClient, type LspClientLogger } from "./client";
import { getServerForLanguage, DEFAULT_LSP_CONFIG } from "./config";
import type { LspSymbolLocation } from "./symbols";
import { findProjectRoot } from "./project-root";
import type { LspConfig } from "./types";
import { createLspCheckToolDefinitions, lspFailureNote } from "./check-tool-def";
import { runWebCheck, type WebCheckDeps } from "./web-check";
import { runChangedChecks } from "./changed-check";
import { runWriteCheck, runPreWriteCheck, type WriteCheckDeps } from "./write-check";
import { warmProjectServers } from "./warmup";
import { diagnoseLspServers, type LspDiagnoseDeps } from "./diagnose";
import { errMsg } from "../../utils";
import { LspHealth } from "./health";
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
  private healthState = new LspHealth();
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

  /** Честный health: серверы на паузе восстановления → degraded с ключами (INV-6). */
  health(): { status: "ok" | "degraded" | "failed"; reason?: string } {
    if (this.config.enabled === false) return { status: "ok" };
    const blocked = this.healthState.blocked();
    if (blocked.length > 0) {
      const keys = blocked.map((b) => `${b.key} (+${Math.round(b.retryInMs / 1000)}s)`).join(", ");
      return { status: "degraded", reason: `lsp servers blocked: ${keys}` };
    }
    return { status: "ok" };
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
    this.healthState.resetAll();
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
    return this.healthState.blocked();
  }

  /** Список ключей серверов на паузе (совместимость с `/lsp status`). */
  getDisabledServers(): string[] {
    return this.healthState.disabledKeys();
  }

  /** Счётчики падений по серверам. */
  getFailureCounts(): Map<string, number> {
    return this.healthState.counts();
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
    return this.healthState.disabledKeys().length > 0;
  }

  /** Тест-хук: стоит ли сервер на паузе восстановления. */
  isServerDisabled(key: string): boolean {
    return this.healthState.isDisabled(key);
  }

  /** Прогрев применимых серверов проекта в фоне (старт сессии). */
  warmProject(): void {
    if (this.warmStarted) return;
    this.warmStarted = true;
    void warmProjectServers({
      config: this.config,
      baseDir: this.baseDir,
      client: this.client,
      health: this.healthState,
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
      onBeforeTool: (ctx, call) => this.checkBeforeWrite(ctx as unknown as ToolContext, call),
      onAfterTool: (ctx, call, result) => this.checkAfterWrite(ctx as unknown as ToolContext, call, result),
    };
  }

  /** Пост-проверка записи (вынесена в `write-check.ts`). */
  /** Pre-write draft check (see `runPreWriteCheck`). */
  private checkBeforeWrite(ctx: ToolContext, call: ToolCall): Promise<string | boolean> {
    return runPreWriteCheck(this.writeDeps(), ctx, call).then((r) => r ?? true);
  }

  private checkAfterWrite(ctx: ToolContext, call: ToolCall, result: ToolResult): Promise<void> {
    return runWriteCheck(this.writeDeps(), ctx, call, result);
  }

  private writeDeps(): WriteCheckDeps {
    return {
      config: this.config,
      client: this.client,
      health: this.healthState,
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

  /** Тул диагностики по требованию (`lsp_check`; см. `check-tool-def.ts`). */
  getToolDefinitions(): ToolDefinition[] {
    return createLspCheckToolDefinitions(this.checkToolDeps());
  }

  private checkToolDeps() {
    return {
      config: this.config,
      client: this.client,
      health: this.healthState,
      logger: this.logger,
      log: (msg: string, meta?: Record<string, unknown>) => this.log(msg, meta),
    };
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
      health: this.healthState,
      logger: this.logger,
      failureNote: (key, serverConfig, message, file) =>
        lspFailureNote(this.healthState, key, serverConfig, message, file),
    };
  }
}

