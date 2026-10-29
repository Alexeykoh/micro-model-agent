// Одно LSP-соединение = один процесс сервера.
//
// Процесс НЕ убивается после каждой проверки: соединение живёт, документы
// синкатся (`didOpen`/`didChange`/`didClose`), диагностики считаются
// актуальными на последнюю версию документа. Убивает соединение только пул
// (LRU/idle) или явный `shutdown()`.
//
// Спавн впрыскивается через `ServerProcessFactory`, поэтому тесты гоняют
// настоящее фреймирование на фейковом сервере без child_process.
import type { LspDiagnostic, LspServerConfig } from "./types";
import { killTree, type KillableProcess } from "../processes/registry";
import { findHeaderEnd, isAcceptableFrameLength, parseContentLength } from "./framing";
import { canonicalUri, pathToUri } from "./uri";
import { buildClientCapabilities } from "./capabilities";
import { settleEmptyDiagnostics, waitForRecord } from "./diagnostics-wait";
import { languageIdForPath } from "./language";
import type { LspClientLogger } from "./client-logger";
import { errMsg } from "../../utils";
import { LSP_DEFAULT_TIMEOUT_MS } from "../../config/timeouts";
import { defaultSpawn, resolveLaunchPlan } from "./spawn";
import { StderrRing } from "./stderr-ring";
import type {
  DiagnosticRecord,
  DocumentDiagnosticReport,
  DocumentState,
  LaunchPlan,
  LspConnectionDeps,
  PublishDiagnosticsParams,
  ServerProcess,
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

/** Ошибка соединения. `fatal` — соединение мертво, переиспользовать нельзя. */
export type LspConnectionError = Error & { fatal?: boolean };

function fatalError(message: string): LspConnectionError {
  const error = new Error(message) as LspConnectionError;
  error.fatal = true;
  return error;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Один процесс сервера: JSON-RPC, синк документов, реестр диагностик. */
export class LspConnection {
  private process: ServerProcess | null = null;
  private readonly pending = new Map<number, PendingEntry>();
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private initialized = false;
  private supportsPull = false;
  private closing = false;
  private lastUsedAt = 0;
  private readonly documents = new Map<string, DocumentState>();
  private readonly diagnostics = new Map<string, DiagnosticRecord>();

  private readonly logger: LspClientLogger | null;
  private readonly offline: boolean | undefined;
  private readonly spawnProcess: ServerProcessFactory;
  private readonly resolveLaunch: (config: LspServerConfig) => LaunchPlan;
  private readonly timeout: number;
  private readonly now: () => number;

  /** Ключ соединения в пуле: `serverKey \0 projectRoot`. */
  readonly key: string;

  /** pid процесса сервера (undefined — сервер не запущен). */
  get processPid(): number | undefined {
    return this.process?.pid;
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
    private readonly projectRoot: string,
    private readonly config: LspServerConfig,
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
  }

  get isOpen(): boolean {
    return this.process !== null && this.initialized;
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
    return [...this.documents.values()].filter((doc) => doc.open).map((doc) => doc.uri);
  }

  /** Запустить сервер и выполнить рукопожатие `initialize` (+ `initialized`). */
  async open(): Promise<void> {
    if (this.isOpen) return;
    this.closing = false;
    this.buffer = Buffer.alloc(0);
    this.documents.clear();
    this.diagnostics.clear();

    const plan = this.resolveLaunch(this.config);
    const params = this.initializeParams();
    await this.spawnAndWire(plan);
    try {
      this.noteInitializeResult(await this.request("initialize", params, this.timeout));
    } catch (e) {
      // npx-докачка на холодном кеше вылетает за таймаут — один ретрай.
      this.logger?.warn(`LSP initialize failed (attempt 1): ${errMsg(e)}`, {
        command: this.config.command,
        projectRoot: this.projectRoot,
      });
      this.teardown();
      await this.spawnAndWire(plan);
      try {
        this.noteInitializeResult(await this.request("initialize", params, this.timeout));
      } catch (retryErr) {
        this.logger?.error(`LSP initialize failed (attempt 2, giving up): ${errMsg(retryErr)}`, {
          command: this.config.command,
          projectRoot: this.projectRoot,
        });
        this.teardown();
        throw retryErr;
      }
    }

    // `initialized` обязателен: без него часть серверов не шлёт диагностики.
    this.notify("initialized", {});
    this.initialized = true;
    this.touch();
  }

  /** Спавн процесса и подписка на его события (exit/error/stdout/stderr). */
  private async spawnAndWire(plan: LaunchPlan): Promise<void> {
    const proc = await this.spawnProcess(plan, this.projectRoot);
    this.process = proc;
    proc.once("exit", () => this.onServerExit(proc));
    this.process.on("error", (error) => {
      this.logger?.debug(`LSP process error: ${errMsg(error)}`, { key: this.key });
    });
    if (this.process.stderr) {
      // stderr сервера ЧИТАЕМ: иначе «болтливый» сервер (npm-предупреждения,
      // краш-логи) забивает пайп и встаёт (аудит §8.2).
      this.process.stderr.on("data", (chunk: Buffer) => {
        this.appendStderr(chunk.toString());
      });
    }
    if (this.process.stdout) {
      this.process.stdout.on("data", (chunk) => this.handleData(chunk));
    }
  }

  /** Параметры `initialize`: корень, capabilities, clientInfo. */
  initializeParams(): Record<string, unknown> {
    const rootUri = pathToUri(this.projectRoot);
    return {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: "workspace" }],
      clientInfo: { name: "micro-models-agent", version: "lsp-connection/1" },
      capabilities: buildClientCapabilities(),
    };
  }

  /** Показать серверу содержимое файла (didOpen или didChange-Full). */
  syncDocument(filePath: string, text: string): string {
    const uri = pathToUri(filePath);
    this.syncUri(uri, languageIdForPath(filePath), text);
    return uri;
  }

  /** То же по готовому URI (используется `workspaceSymbol`-путями и тестами). */
  syncUri(uri: string, languageId: string, text: string): void {
    if (!this.isOpen) throw fatalError("LSP connection is not open");
    uri = canonicalUri(uri);
    const current = this.documents.get(uri);
    if (current?.open && current.text === text) {
      this.touch();
      return;
    }
    if (!current?.open) {
      this.documents.set(uri, { uri, languageId, version: 1, text, open: true });
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId, version: 1, text },
      });
      return;
    }
    const next: DocumentState = { ...current, version: current.version + 1, text };
    this.documents.set(uri, next);
    this.notify("textDocument/didChange", {
      textDocument: { uri, version: next.version },
      contentChanges: [{ text }],
    });
    this.touch();
  }

  /** `didClose` — парная к `didOpen` нотификация; чистит и диагностики. */
  closeDocument(filePath: string): void {
    this.closeDocUri(pathToUri(filePath));
  }

  closeDocUri(uri: string): void {
    uri = canonicalUri(uri);
    const doc = this.documents.get(uri);
    if (!doc?.open || !this.isOpen) return;
    this.documents.set(uri, { ...doc, open: false });
    this.diagnostics.delete(uri);
    this.notify("textDocument/didClose", { textDocument: { uri } });
    this.touch();
  }

  /**
   * Диагностика документа. Возвращает:
   * - список (в т.ч. пустой) — это ответ сервера;
   * - `null` — сервер молчит (таймаут/нет push) — ответа нет, это не «чисто».
   */  async diagnosticsFor(uri: string, timeoutMs: number): Promise<LspDiagnostic[] | null> {
    if (!this.isOpen) return null;
    uri = canonicalUri(uri);
    const doc = this.documents.get(uri);
    const version = doc?.version ?? -1;

    if (this.supportsPull) {
      const pulled = await this.pullDiagnostics(uri, version, timeoutMs);
      if (pulled) return pulled;
    }

    if (!doc?.open) return null;
    const diagnostics =
      this.freshDiagnostics(uri, version) ??
      (await waitForRecord(() => this.diagnostics.get(uri), version, timeoutMs))?.diagnostics ??
      null;
    if (!diagnostics || diagnostics.length > 0) return diagnostics;
    return (await settleEmptyDiagnostics(() => this.diagnostics.get(uri), version)) ?? diagnostics;
  }

  /** Диагностики запрошенной версии; null — устаревших/нет (аудит §8.3). */
  private freshDiagnostics(uri: string, version: number): LspDiagnostic[] | null {
    const record = this.diagnostics.get(uri);
    return record && record.version === version ? record.diagnostics : null;
  }

  /** Pull-модель: явный `textDocument/diagnostic` (сервер объявил support). */
  private async pullDiagnostics(
    uri: string,
    version: number,
    timeoutMs: number,
  ): Promise<LspDiagnostic[] | null> {
    const report = (await this.request(
      "textDocument/diagnostic",
      { textDocument: { uri } },
      timeoutMs,
    ).catch(() => null)) as DocumentDiagnosticReport | null;
    if (report?.kind !== "full") return null;
    const items = report.items ?? [];
    this.diagnostics.set(uri, { version, diagnostics: items });
    this.touch();
    return items;
  }

  /** Актуальный список диагностик без ожидания (для быстрых путей). */
  peekDiagnostics(uri: string): DiagnosticRecord | null {
    return this.diagnostics.get(canonicalUri(uri)) ?? null;
  }

  async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!this.process) throw fatalError(`LSP request ${method}: no process`);
    const id = this.nextId++;
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const entry: PendingEntry = { resolve: null, reject: null };
    const promise = new Promise<unknown>((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    this.pending.set(id, entry);
    this.write(message);
    const timer = setTimeout(() => {
      if (this.pending.delete(id)) {
        entry.reject?.(new Error(`LSP request timeout: ${method}`));
      }
    }, timeoutMs);
    try {
      return await promise;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Корректно закрыть: `shutdown` → `exit` → пауза → tree-kill. */
  async shutdown(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    try {
      if (this.process && this.initialized) {
        // Ответ shutdown ждём, чтобы сервер успел закрыть файлы до kill.
        await this.request("shutdown", null, 3000).catch((e) => {
          this.logger?.debug(`LSP shutdown request failed: ${errMsg(e)}`);
        });
        this.notify("exit", null);
        await delay(150);
      }
    } catch (e) {
      this.logger?.debug(`LSP shutdown error: ${errMsg(e)}`);
    } finally {
      this.teardown();
    }
  }

  /** Запомнить возможности сервера из ответа `initialize`. */
  private noteInitializeResult(result: unknown): void {
    const capabilities = (result as { capabilities?: Record<string, unknown> } | null)?.capabilities;
    this.supportsPull = Boolean(capabilities?.diagnosticProvider);
  }

  private onServerExit(exited?: ServerProcess): void {
    // Выход СТАРОГО процесса не должен ронять новое соединение: ретрай
    // open() поднимает новый процесс, а exit предыдущего приходит позже
    // (аудит §8.4).
    if (exited && this.process && exited !== this.process) {
      this.logger?.debug("LSP server exited (stale process)", { key: this.key });
      return;
    }
    this.logger?.debug("LSP server exited", { key: this.key });
    this.teardown();
  }

  private teardown(): void {
    const proc = this.process;
    this.process = null;
    this.initialized = false;
    this.supportsPull = false;
    this.buffer = Buffer.alloc(0);
    this.documents.clear();
    this.diagnostics.clear();
    for (const entry of this.pending.values()) {
      entry.reject?.(fatalError("LSP server exited"));
    }
    this.pending.clear();
    if (proc) {
      try {
        killTree(proc as unknown as KillableProcess);
      } catch (e) {
        // Провал гашения — это событие, а не шум: сервер может остаться жить
        // (аудит §8.1).
        this.logger?.warn(`lsp.kill_failed: ${errMsg(e)}`);
      }
    }
  }

  private handleData(chunk: Buffer): void {
    this.buffer = this.buffer.length
      ? Buffer.concat([this.buffer, chunk])
      : Buffer.from(chunk);
    this.parse();
  }

  private parse(): void {
    for (;;) {
      const found = findHeaderEnd(this.buffer);
      if (!found) return;
      const header = this.buffer.subarray(0, found.headerEnd).toString("utf8");
      const length = parseContentLength(header);
      // Битый/абсурдный заголовок: пропускаем его секцию, иначе зациклимся.
      if (length === null || !isAcceptableFrameLength(length)) {
        this.buffer = this.buffer.subarray(found.headerEnd);
        continue;
      }
      const bodyStart = found.headerEnd;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(body) as Record<string, unknown>;
      } catch (e) {
        this.logger?.debug(`LSP JSON parse error: ${errMsg(e)}`);
        continue;
      }
      this.handleMessage(message);
    }
  }

  private handleMessage(message: Record<string, unknown>): void {
    const method = typeof message.method === "string" ? message.method : null;
    const id = typeof message.id === "number" || typeof message.id === "string" ? message.id : null;

    // Ответ на наш запрос.
    if (method === null) {
      this.resolvePending(id, message);
      return;
    }
    // Запрос от сервера к нам.
    if (id !== null) {
      this.replyToServerRequest(method, id);
      return;
    }
    if (method === "textDocument/publishDiagnostics") {
      this.acceptDiagnostics(message.params as PublishDiagnosticsParams | undefined);
    }
  }

  /** Найти и завершить ожидающий запрос по id (результат или ошибка). */
  private resolvePending(id: number | string | null, message: Record<string, unknown>): void {
    if (id === null) return;
    const entry = this.pending.get(id as number);
    if (!entry) return;
    this.pending.delete(id as number);
    if (message.error) {
      const error = message.error as { message?: unknown };
      entry.reject?.(new Error(String(error.message ?? "LSP error")));
    } else {
      entry.resolve?.(message.result);
    }
  }

  /**
   * Ответить на запрос сервера: молчание подвешивает его
   * (`workspace/configuration`, `client/registerCapability`). `initialize`
   * пропускаем — это не server->client запрос на этом этапе.
   */
  private replyToServerRequest(method: string, id: number | string): void {
    if (method === "initialize") return;
    this.write(JSON.stringify({ jsonrpc: "2.0", id, result: null }));
    this.logger?.debug(`LSP answered server->client request: ${method}`, { key: this.key });
  }

  private acceptDiagnostics(params: PublishDiagnosticsParams | undefined): void {
    if (!params?.uri || !Array.isArray(params.diagnostics)) return;
    // Сервер присылает свой вариант file-URI (`e%3A` vs `E:`): без канонизации
    // пуш не находил открытый документ и молча отбрасывался.
    const uri = canonicalUri(params.uri);
    const doc = this.documents.get(uri);
    if (!doc?.open) return;
    // Пуш от старой версии документа — игнор (антиретро-правки).
    if (params.version !== undefined && params.version < doc.version) return;
    // Сохраняем ВЕРСИЮ, за которую сервер считал: текущая версия документа могла
    // уехать вперёд, и тогда диагностики помечались бы как свежие (аудит §8.3).
    const version = params.version ?? doc.version;
    this.diagnostics.set(uri, { version, diagnostics: params.diagnostics });
    this.touch();
  }

  private notify(method: string, params: unknown): void {
    this.write(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  private write(message: string): void {
    const proc = this.process;
    if (!proc?.stdin?.writable) return;
    const header = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n`;
    try {
      proc.stdin.write(header + message);
    } catch (e) {
      this.logger?.debug(`LSP write error: ${errMsg(e)}`);
    }
  }
}

interface PendingEntry {
  resolve: ((value: unknown) => void) | null;
  reject: ((reason: Error) => void) | null;
}

/** Ключ записи в пуле: идентичность сервера + корень проекта. */
export function poolKey(serverKey: string, projectRoot: string): string {
  return `${serverKey}\u0000${projectRoot}`;
}

export { buildClientCapabilities };
