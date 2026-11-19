// JSON-RPC поверх stdio: фрейминг `Content-Length`, ожидающие запросы и
// ответы на server->client запросы одного LSP-соединения.
//
// Вынесено из `connection.ts` (правило 6). Транспорт не знает про документы:
// нотификации отдаются наверх через `onNotification`.
import type { LspClientLogger } from "./client-logger";
import type { ServerProcess } from "./connection-types";
import { fatalError } from "./connection-errors";
import { findHeaderEnd, isAcceptableFrameLength, parseContentLength } from "./framing";
import { errMsg } from "../../utils";

export interface RpcChannelDeps {
  /** Текущий процесс (null — соединение не поднято). */
  getProcess: () => ServerProcess | null;
  logger: LspClientLogger | null;
  /** Ключ соединения для debug-лога. */
  key: string;
  /** Нотификация сервера (не ответ на запрос и не запрос к клиенту). */
  onNotification: (method: string, params: unknown) => void;
  /** Разобранное сообщение (ответ, запрос или нотификация). */
  onMessage: (message: Record<string, unknown>) => void;
}

interface PendingEntry {
  resolve: ((value: unknown) => void) | null;
  reject: ((reason: Error) => void) | null;
}

export class RpcChannel {
  private readonly pending = new Map<number, PendingEntry>();
  private nextId = 1;
  private buffer = Buffer.alloc(0);

  constructor(private readonly deps: RpcChannelDeps) {}

  /** Сбросить накопленный буфер (новое соединение или teardown). */
  resetBuffer(): void {
    this.buffer = Buffer.alloc(0);
  }

  /** Отклонить все ожидающие запросы и очистить реестр (процесс умер). */
  rejectAll(reason: Error): void {
    for (const entry of this.pending.values()) {
      entry.reject?.(reason);
    }
    this.pending.clear();
  }

  async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!this.deps.getProcess()) throw fatalError(`LSP request ${method}: no process`);
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

  notify(method: string, params: unknown): void {
    this.write(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  handleData(chunk: Buffer): void {
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
        this.deps.logger?.debug(`LSP JSON parse error: ${errMsg(e)}`);
        continue;
      }
      this.deps.onMessage(message);
    }
  }

  /** Разобрать сообщение: ответ, запрос сервера или нотификация. */
  dispatch(message: Record<string, unknown>): void {
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
    this.deps.onNotification(method, message.params);
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
    this.deps.logger?.debug(`LSP answered server->client request: ${method}`, {
      key: this.deps.key,
    });
  }

  private write(message: string): void {
    const proc = this.deps.getProcess();
    if (!proc?.stdin?.writable) return;
    const header = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n`;
    try {
      proc.stdin.write(header + message);
    } catch (e) {
      // DEBT(lsp-protocol-error-counter): протокольная ошибка записи только
      // логируется — счётчика «≤3 подряд, потом shutdown» (как в
      // vscode-languageclient DefaultErrorHandler.error) ещё нет.
      this.deps.logger?.debug(`LSP write error: ${errMsg(e)}`);
    }
  }
}
