// Жизненный цикл процесса LSP-сервера: спавн, рукопожатие, shutdown и teardown.
//
// Вынесено из `connection.ts` (правило 6). Соединение отвечает за документы,
// диагностики и stderr; транспорт — в `rpc.ts`.
import { errMsg } from "../../utils";
import { killTree, type KillableProcess } from "../processes/registry";
import type { LspClientLogger } from "./client-logger";
import { buildInitializeParams, exitReason } from "./connection-intro";
import { fatalError } from "./connection-errors";
import type {
  LaunchPlan,
  LspExitInfo,
  ServerProcess,
  ServerProcessFactory,
} from "./connection-types";
import { initializeWithRetry } from "./handshake";
import type { RpcChannel } from "./rpc";
import { spawnAndWireProcess } from "./server-wire";
import type { LspServerConfig } from "./types";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface ServerLifecycleDeps {
  config: LspServerConfig;
  projectRoot: string;
  timeout: number;
  logger: LspClientLogger | null;
  /** Ключ соединения для debug-лога. */
  key: string;
  spawn: ServerProcessFactory;
  resolveLaunch: (config: LspServerConfig) => LaunchPlan;
  rpc: RpcChannel;
  /** Забыть буфер транспорта и документы (новое соединение или teardown). */
  clearState: () => void;
  /** Кусок stdout процесса (фрейминг). */
  onStdout: (chunk: Buffer) => void;
  /** Дописать stderr процесса в кольцо соединения. */
  onStderr: (chunk: string) => void;
  /** Отметить соединение использованным (idle/LRU). */
  touch: () => void;
}

export class ServerLifecycle {
  private process: ServerProcess | null = null;
  private initialized = false;
  private supportsPull = false;
  private closing = false;
  /** Как завершился процесс (код/сигнал) — по спеке 0 = чистый, 1 = крах. */
  private exitInfo: LspExitInfo | null = null;

  constructor(private readonly deps: ServerLifecycleDeps) {}

  get isOpen(): boolean {
    return this.process !== null && this.initialized;
  }

  /** Сервер объявил pull-модель диагностик. */
  get supportsDiagnosticsPull(): boolean {
    return this.supportsPull;
  }

  get processPid(): number | undefined {
    return this.process?.pid;
  }

  get processRef(): ServerProcess | null {
    return this.process;
  }

  /** Код/сигнал завершения (null — не завершался). */
  get lastExit(): LspExitInfo | null {
    return this.exitInfo;
  }

  /** Запустить сервер и выполнить рукопожатие `initialize` (+ `initialized`). */
  async open(): Promise<void> {
    if (this.isOpen) return;
    this.closing = false;
    this.deps.clearState();

    const plan = this.deps.resolveLaunch(this.deps.config);
    const params = buildInitializeParams(this.deps.projectRoot, this.deps.config);
    await this.spawnAndWire(plan);
    await initializeWithRetry(params, {
      logger: this.deps.logger,
      command: this.deps.config.command,
      projectRoot: this.deps.projectRoot,
      timeout: this.deps.timeout,
      request: (method, methodParams, timeoutMs) =>
        this.deps.rpc.request(method, methodParams, timeoutMs),
      respawn: () => this.spawnAndWire(plan),
      teardown: () => this.teardown(),
      onResult: (result) => this.noteInitializeResult(result),
    });

    // `initialized` обязателен: без него часть серверов не шлёт диагностики.
    this.deps.rpc.notify("initialized", {});
    this.initialized = true;
    this.deps.touch();
  }

  /** Корректно закрыть: `shutdown` → `exit` → пауза → tree-kill. */
  async shutdown(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    try {
      if (this.process && this.initialized) {
        // Ответ shutdown ждём, чтобы сервер успел закрыть файлы до kill.
        await this.deps.rpc.request("shutdown", null, 3000).catch((e) => {
          this.deps.logger?.debug(`LSP shutdown request failed: ${errMsg(e)}`);
        });
        this.deps.rpc.notify("exit", null);
        await delay(150);
      }
    } catch (e) {
      this.deps.logger?.debug(`LSP shutdown error: ${errMsg(e)}`);
    } finally {
      this.teardown();
    }
  }

  /** Спавн процесса и подписка на его события (exit/error/stdout/stderr). */
  private async spawnAndWire(plan: LaunchPlan): Promise<void> {
    await spawnAndWireProcess(
      this.deps.spawn,
      plan,
      this.deps.projectRoot,
      {
        onExit: (proc, code, signal) => this.onServerExit(proc, code, signal),
        onError: (error) => {
          this.deps.logger?.debug(`LSP process error: ${errMsg(error)}`, { key: this.deps.key });
        },
        onStdout: (chunk) => this.deps.onStdout(chunk),
        stderr: (chunk) => this.deps.onStderr(chunk),
      },
      (proc) => {
        this.process = proc;
        this.exitInfo = null;
      },
    );
  }

  /** Запомнить возможности сервера из ответа `initialize`. */
  private noteInitializeResult(result: unknown): void {
    const capabilities = (result as { capabilities?: Record<string, unknown> } | null)?.capabilities;
    this.supportsPull = Boolean(capabilities?.diagnosticProvider);
  }

  private onServerExit(exited?: ServerProcess, code?: number | null, signal?: string | null): void {
    // Выход СТАРОГО процесса не должен ронять новое соединение: ретрай
    // open() поднимает новый процесс, а exit предыдущего приходит позже
    // (аудит §8.4).
    if (exited && this.process && exited !== this.process) {
      this.deps.logger?.debug("LSP server exited (stale process)", { key: this.deps.key });
      return;
    }
    // Код выхода: 0 — чистый (после shutdown), 1/сигнал — крах.
    this.exitInfo = { code: code ?? null, signal: signal ?? null };
    this.deps.logger?.debug(
      `LSP server exited (code ${code ?? "?"}${signal ? `, signal ${signal}` : ""})`,
      { key: this.deps.key },
    );
    this.teardown();
  }

  /** Причина завершения для ошибок ожидающих запросов (код/сигнал). */
  private teardown(): void {
    const proc = this.process;
    this.process = null;
    this.initialized = false;
    this.supportsPull = false;
    this.deps.clearState();
    this.deps.rpc.rejectAll(fatalError(exitReason(this.exitInfo)));
    if (!proc) return;
    try {
      killTree(proc as unknown as KillableProcess);
    } catch (e) {
      // Провал гашения — это событие, а не шум: сервер может остаться жить
      // (аудит §8.1).
      this.deps.logger?.warn(`lsp.kill_failed: ${errMsg(e)}`);
    }
  }
}
