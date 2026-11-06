// Одно LSP-соединение = один процесс сервера.
//
// Процесс НЕ убивается после каждой проверки: соединение живёт, документы
// синкатся (`didOpen`/`didChange`/`didClose`), диагностики считаются
// актуальными на последнюю версию документа. Убивает соединение только пул
// (LRU/idle) или явный `shutdown()`.
//
// Спавн впрыскивается через `ServerProcessFactory`, поэтому тесты гоняют
// настоящее фреймирование на фейковом сервере без child_process.
//
// Транспорт — в `rpc.ts`, документы и диагностики — в `documents.ts`,
// жизненный цикл процесса — в `server-lifecycle.ts` (правило 6).
import type { LspDiagnostic, LspServerConfig } from "./types";
import { pathToUri } from "./uri";
import { buildClientCapabilities } from "./capabilities";
import { languageIdForPath } from "./language";
import type { LspClientLogger } from "./client-logger";
import { LSP_DEFAULT_TIMEOUT_MS } from "../../config/timeouts";
import { defaultSpawn, resolveLaunchPlan } from "./spawn";
import { StderrRing } from "./stderr-ring";
import { progressTextOf } from "./connection-intro";
import { DocumentStore } from "./documents";
import { RpcChannel } from "./rpc";
import { ServerLifecycle } from "./server-lifecycle";
import type {
  DiagnosticRecord,
  LaunchPlan,
  LspConnectionDeps,
  LspExitInfo,
  PublishDiagnosticsParams,
  ServerProcessFactory,
} from "./connection-types";

// Спавн и резолв команды — в `spawn.ts`; реэкспорт для существующих импортёров.
export { defaultSpawn, resolveLaunchPlan } from "./spawn";

// Контракты процесса — в `connection-types.ts`; реэкспорт для импортёров.
export type {
  DiagnosticRecord,
  DocumentDiagnosticReport,
  DocumentState,
  LaunchPlan,
  LspConnectionDeps,
  LspPoolDeps,
  PublishDiagnosticsParams,
  ServerProcess,
  ServerProcessFactory,
  ServerStdout,
} from "./connection-types";

// Ошибки соединения — в `connection-errors.ts`; реэкспорт для импортёров.
export type { LspConnectionError } from "./connection-errors";

/** Один процесс сервера: JSON-RPC, синк документов, реестр диагностик. */
export class LspConnection {
  /** Последний `$/progress` от сервера (например, «загружаю проект»). */
  private progressText: string | null = null;
  private lastUsedAt = 0;

  private readonly logger: LspClientLogger | null;
  private readonly offline: boolean | undefined;
  private readonly spawnProcess: ServerProcessFactory;
  private readonly resolveLaunch: (config: LspServerConfig) => LaunchPlan;
  private readonly timeout: number;
  private readonly now: () => number;
  private readonly store: DocumentStore;
  private readonly rpc: RpcChannel;
  private readonly lifecycle: ServerLifecycle;

  /** Ключ соединения в пуле: `serverKey \0 projectRoot`. */
  readonly key: string;

  /** pid процесса сервера (undefined — сервер не запущен). */
  get processPid(): number | undefined {
    return this.lifecycle.processPid;
  }

  /** Код/сигнал завершения (null — не завершался). */
  get lastExit(): LspExitInfo | null {
    return this.lifecycle.lastExit;
  }
  get lastProgress(): string | null {
    return this.progressText;
  }

  /**
   * Хвост stderr сервера (последние 4 КБ) — для диагностики. Отдаётся в
   * `/lsp doctor` через `LspClient.probe` (ошибка несёт `stderrTail`).
   */
  get stderrTail(): string {
    return this.stderr.tail;
  }

  /** Кольцо stderr: сервер «болтает» — пайп не должен переполняться. */
  private readonly stderr = new StderrRing();

  /** Дописать кусок stderr в кольцо и слить в debug-лог. */
  private appendStderr(chunk: string): void {
    this.stderr.push(chunk);
    this.logger?.debug(`LSP stderr: ${chunk.slice(0, 500)}`, { key: this.key });
  }

  constructor(
    serverKey: string,
    projectRoot: string,
    config: LspServerConfig,
    deps: LspConnectionDeps = {},
  ) {
    this.logger = deps.logger ?? null;
    this.offline = deps.offline;
    this.spawnProcess = deps.spawn ?? defaultSpawn;
    this.timeout = deps.timeout ?? config.timeout ?? LSP_DEFAULT_TIMEOUT_MS;
    this.now = deps.now ?? (() => Date.now());
    this.key = poolKey(serverKey, projectRoot);
    this.lastUsedAt = this.now();
    this.resolveLaunch =
      deps.resolveLaunch ??
      ((cfg: LspServerConfig) => resolveLaunchPlan(cfg, this.offline, this.logger));
    this.store = new DocumentStore({
      isOpen: () => this.lifecycle.isOpen,
      supportsPull: () => this.lifecycle.supportsDiagnosticsPull,
      request: (method, params, timeoutMs) => this.rpc.request(method, params, timeoutMs),
      notify: (method, params) => this.rpc.notify(method, params),
      touch: () => this.touch(),
    });
    this.rpc = new RpcChannel({
      getProcess: () => this.lifecycle.processRef,
      logger: this.logger,
      key: this.key,
      onNotification: (method, params) => this.handleNotification(method, params),
      onMessage: (message) => this.handleMessage(message),
    });
    this.lifecycle = new ServerLifecycle({
      config,
      projectRoot,
      timeout: this.timeout,
      logger: this.logger,
      key: this.key,
      spawn: this.spawnProcess,
      resolveLaunch: this.resolveLaunch,
      rpc: this.rpc,
      clearState: () => {
        this.rpc.resetBuffer();
        this.store.clear();
      },
      onStdout: (chunk) => this.handleData(chunk),
      onStderr: (chunk) => this.appendStderr(chunk),
      touch: () => this.touch(),
    });
  }

  get isOpen(): boolean {
    return this.lifecycle.isOpen;
  }

  /** Время последнего использования (для idle-reap и LRU в пуле). */
  touch(): void {
    this.lastUsedAt = this.now();
  }

  idleFor(now = this.now()): number {
    return now - this.lastUsedAt;
  }

  /** Открытые сейчас документы (для статуса UI). */
  openDocumentUris(): string[] {
    return this.store.openUris();
  }

  /** Запустить сервер и выполнить рукопожатие `initialize` (+ `initialized`). */
  open(): Promise<void> {
    return this.lifecycle.open();
  }

  /** Корректно закрыть: `shutdown` → `exit` → пауза → tree-kill. */
  shutdown(): Promise<void> {
    return this.lifecycle.shutdown();
  }

  /** Показать серверу содержимое файла (didOpen или didChange-Full). */
  syncDocument(filePath: string, text: string): string {
    const uri = pathToUri(filePath);
    this.syncUri(uri, languageIdForPath(filePath), text);
    return uri;
  }

  /** То же по готовому URI (используется `workspaceSymbol`-путями и тестами). */
  syncUri(uri: string, languageId: string, text: string): void {
    this.store.sync(uri, languageId, text);
  }

  /** Синк черновика pre-write проверки (не содержимое диска). */
  syncDraftUri(uri: string, languageId: string, text: string): void {
    this.store.syncDraft(uri, languageId, text);
  }

  /**
   * Перечитать открытые документы, изменённые на диске вне write-хуков.
   * Возвращает true, если что-то пересинкано.
   */
  refreshDocuments(): boolean {
    return this.store.refreshFromDisk();
  }

  /** `didClose` — парная к `didOpen` нотификация; чистит и диагностики. */
  closeDocument(filePath: string): void {
    this.closeDocUri(pathToUri(filePath));
  }

  closeDocUri(uri: string): void {
    this.store.close(uri);
  }

  /**
   * Диагностика документа. Возвращает:
   * - список (в т.ч. пустой) — это ответ сервера;
   * - `null` — сервер молчит (таймаут/нет push) — ответа нет, это не «чисто».
   */
  diagnosticsFor(uri: string, timeoutMs: number): Promise<LspDiagnostic[] | null> {
    return this.store.diagnosticsFor(uri, timeoutMs);
  }

  /** Актуальный список диагностик без ожидания (для быстрых путей). */
  peekDiagnostics(uri: string): DiagnosticRecord | null {
    return this.store.peek(uri);
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    return this.rpc.request(method, params, timeoutMs);
  }

  /** Принять кусок stdout (тесты гоняют фрейминг байт-в-байт). */
  private handleData(chunk: Buffer): void {
    this.rpc.handleData(chunk);
  }

  /** Разобрать сообщение сервера (тесты подменяют, чтобы видеть поток). */
  private handleMessage(message: Record<string, unknown>): void {
    this.rpc.dispatch(message);
  }

  /** Нотификации сервера: диагностики (push) и прогресс. */
  private handleNotification(method: string, params: unknown): void {
    if (method === "textDocument/publishDiagnostics") {
      this.store.acceptDiagnostics(params as PublishDiagnosticsParams | undefined);
      return;
    }
    if (method === "$/progress") {
      this.progressText = progressTextOf(params);
    }
  }
}

/** Ключ записи в пуле: идентичность сервера + корень проекта. */
export function poolKey(serverKey: string, projectRoot: string): string {
  return `${serverKey}\u0000${projectRoot}`;
}

export { buildClientCapabilities };
