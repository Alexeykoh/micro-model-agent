// Одно LSP-соединение = один процесс сервера.
//
// Отличие от прежней реализации (`client.ts` до 2.39): процесс НЕ убивается
// после каждой проверки. Соединение живёт, документы синкатся
// (`didOpen`/`didChange`/`didClose`), диагностики считаются актуальными на
// последнюю версию документа. Убивает соединение только пул (LRU/idle) или
// явный `shutdown()`.
//
// Спавн впрыскивается через `ServerProcessFactory`, поэтому тесты гоняют
// настоящее фреймирование и корреляцию на фейковом сервере без child_process.
import type { LspDiagnostic, LspServerConfig } from "./types";
import { resolveSpawnCommand, buildWinCommandLine } from "./command";
import { resolveNpxLaunch, isOfflineLsp } from "./resolve";
import { killTree, type KillableProcess } from "../processes/registry";
import { findHeaderEnd, isAcceptableFrameLength, parseContentLength } from "./framing";
import { pathToUri } from "./uri";
import { languageIdForPath } from "./language";
import type { LspClientLogger } from "./client-logger";
import { errMsg } from "../../utils";
import { LSP_DEFAULT_TIMEOUT_MS } from "../../config/timeouts";

/** Поток stdout процесса сервера в объёме, нужном транспорту. */
export interface ServerStdout {
  on(event: "data", cb: (chunk: Buffer) => void): void;
}

/** Минимум от процесса сервера (удовлетворяется `ChildProcess`). */
export interface ServerProcess {
  stdin: { writable: boolean; write(chunk: string): boolean } | null;
  stdout: ServerStdout | null;
  kill(signal?: number | string): boolean;
  once(event: "exit", cb: () => void): void;
  on(event: "error", cb: (error: Error) => void): void;
}

/** Как именно нужно стартовать процесс (после резолва npx/офлайна). */
export interface LaunchPlan {
  command: string;
  args: string[];
}

/** Фабрика процесса сервера; по умолчанию — реальный spawn с Windows-путём. */
export type ServerProcessFactory = (plan: LaunchPlan, cwd: string) => Promise<ServerProcess>;

/** Состояние одного синкаемого документа (версия для `didChange`). */
export interface DocumentState {
  uri: string;
  languageId: string;
  version: number;
  text: string;
  open: boolean;
}

/** Запись диагностик документа: версия, на которой они посчитаны. */
export interface DiagnosticRecord {
  version: number;
  diagnostics: LspDiagnostic[];
}

/** Тело `textDocument/publishDiagnostics`. */
export interface PublishDiagnosticsParams {
  uri: string;
  diagnostics?: LspDiagnostic[];
  version?: number;
}

/** Ответ `textDocument/diagnostic` (pull-модель, LSP 3.17). */
export interface DocumentDiagnosticReport {
  kind?: "full" | "unchanged";
  items?: LspDiagnostic[];
  resultId?: string;
}

/** Что нужно соединению извне: логгер, офлайн-флаг, инъекции для тестов. */
export interface LspConnectionDeps {
  logger?: LspClientLogger | null;
  offline?: boolean;
  spawn?: ServerProcessFactory;
  /** Резолв команды запуска (тесты). */
  resolveLaunch?: (config: LspServerConfig) => LaunchPlan;
  /** Источник времени (пул/тесты). По умолчанию — реальные часы. */
  now?: () => number;
}

/** Депы пула: всё, что нужно соединениям, кроме часов (их ведёт пул). */
export type LspPoolDeps = Omit<LspConnectionDeps, "now">;

/** Ошибка соединения. `fatal` — соединение мертво, переиспользовать нельзя. */
export type LspConnectionError = Error & { fatal?: boolean };

function fatalError(message: string): LspConnectionError {
  const error = new Error(message) as LspConnectionError;
  error.fatal = true;
  return error;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Эффективная команда запуска: npx→глобальный бинарник, офлайн-гейт.
 * Windows-обвязка (.cmd через cmd.exe) живёт в фабрике спавна — резолв команды
 * и способ её запустить это разные concerns.
 */
export function resolveLaunchPlan(
  config: LspServerConfig,
  offline: boolean | undefined,
  logger?: LspClientLogger | null,
): LaunchPlan {
  const launch = resolveNpxLaunch(config.command, config.args ?? []);
  if (launch.command !== config.command) {
    logger?.debug(`LSP: using globally installed ${launch.binaryName} (skipped npx)`);
  } else if (launch.useNpxFallback && launch.binaryName) {
    logger?.debug(`LSP: ${launch.binaryName} not found globally, falling back to npx`);
  }
  if (launch.useNpxFallback && isOfflineLsp(undefined, offline)) {
    throw new Error(
      `LSP offline mode: ${launch.binaryName ?? "npx"} not found in PATH; ` +
        "npx auto-install is disabled (MMA_LSP_OFFLINE)",
    );
  }
  return { command: launch.command, args: launch.args };
}

/**
 * Дефолтная фабрика: `child_process.spawn`. На Windows `.cmd`/`.bat`-шим
 * (`npx.cmd`, `tsc.cmd`) не стартует напрямую — поэтому команда со аргументами
 * склеиваются и уходят через `shell: true` (`cmd.exe /d /s /c`).
 */
export const defaultSpawn: ServerProcessFactory = async (plan, cwd) => {
  const { spawn } = await import("child_process");
  const isWin = platformIsWindows();
  let command = resolveSpawnCommand(plan.command);
  let args = plan.args;
  const options: Record<string, unknown> = {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
    windowsHide: true,
    // POSIX: потомок — лидер группы, чтобы `killTree()` достал всю цепочку
    // (npx → node → tsserver). Windows — taskkill /T.
    detached: !isWin,
  };
  if (isWin) {
    command = buildWinCommandLine(command, args);
    args = [];
    options.shell = true;
  }
  const child = spawn(command, args, options) as unknown as {
    stdin: ServerProcess["stdin"];
    stdout: ServerProcess["stdout"];
    kill(signal?: number | string): boolean;
    once(event: "exit", cb: () => void): unknown;
    on(event: "error", cb: (error: Error) => void): unknown;
    on(event: "data", cb: (chunk: Buffer) => void): unknown;
  };
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    kill: (signal) => child.kill(signal),
    once: (event, cb) => {
      child.once(event, cb);
    },
    on: (event, cb) => {
      if (event === "error") child.on("error", cb);
    },
  };
};

function platformIsWindows(): boolean {
  return process.platform === "win32";
}

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

  constructor(
    serverKey: string,
    private readonly projectRoot: string,
    private readonly config: LspServerConfig,
    deps: LspConnectionDeps = {},
  ) {
    this.logger = deps.logger ?? null;
    this.offline = deps.offline;
    this.spawnProcess = deps.spawn ?? defaultSpawn;
    this.timeout = config.timeout ?? LSP_DEFAULT_TIMEOUT_MS;
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

  /** Спавн процесса и подписка на его события (exit/error/stdout). */
  private async spawnAndWire(plan: LaunchPlan): Promise<void> {
    this.process = await this.spawnProcess(plan, this.projectRoot);
    this.process.once("exit", () => this.onServerExit());
    this.process.on("error", (error) => {
      this.logger?.debug(`LSP process error: ${errMsg(error)}`, { key: this.key });
    });
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
   */
  async diagnosticsFor(uri: string, timeoutMs: number): Promise<LspDiagnostic[] | null> {
    if (!this.isOpen) return null;
    const doc = this.documents.get(uri);
    const version = doc?.version ?? -1;

    if (this.supportsPull) {
      const pulled = await this.pullDiagnostics(uri, version, timeoutMs);
      if (pulled) return pulled;
    }

    if (!doc?.open) return null;
    return this.freshDiagnostics(uri, version) ?? this.waitForPush(uri, version, timeoutMs);
  }

  /** Диагностики актуальной версии без ожидания; null — устаревших/нет. */
  private freshDiagnostics(uri: string, version: number): LspDiagnostic[] | null {
    const record = this.diagnostics.get(uri);
    return record && record.version >= version ? record.diagnostics : null;
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

  /** Push-модель: ждём `publishDiagnostics` актуальной версии до дедлайна. */
  private async waitForPush(
    uri: string,
    version: number,
    timeoutMs: number,
  ): Promise<LspDiagnostic[] | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const record = this.diagnostics.get(uri);
      if (record && record.version >= version) return record.diagnostics;
      const left = deadline - Date.now();
      if (left <= 0) return null;
      await delay(Math.min(left, 25));
    }
  }

  /** Актуальный список диагностик без ожидания (для быстрых путей). */
  peekDiagnostics(uri: string): DiagnosticRecord | null {
    return this.diagnostics.get(uri) ?? null;
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

  private onServerExit(): void {
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
        this.logger?.debug(`LSP killTree error: ${errMsg(e)}`);
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
    const uri = params.uri;
    const doc = this.documents.get(uri);
    if (!doc?.open) return;
    // Пуш от старой версии документа — игнор (антиретро-правки).
    if (params.version !== undefined && params.version < doc.version) return;
    this.diagnostics.set(uri, { version: doc.version, diagnostics: params.diagnostics });
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

/** Клиентские capabilities: ровно тот минимум, который нужен харнессу. */
export function buildClientCapabilities(): Record<string, unknown> {
  return {
    // 3.17: смещение в позициях договаривается. utf-16 — единственный
    // обязательный к поддержке, он и остаётся дефолтом.
    general: { positionEncodings: ["utf-16"] },
    textDocument: {
      publishDiagnostics: { relatedInformation: true, versionSupport: true },
      // 3.17 pull-модель: объявляем, что умеем принимать диагностики по запросу.
      diagnostic: {},
    },
    workspace: { symbol: {} },
  };
}
