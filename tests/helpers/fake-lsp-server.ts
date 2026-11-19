// Фейковый LSP-сервер для тестов транспорта: настоящее фреймирование
// (Content-Length + JSON-RPC) в памяти, без child_process.
import { EventEmitter } from "events";
import { PassThrough } from "stream";

export interface FakeServerScript {
  /** Ответы на методы запросов: `initialize`, `textDocument/diagnostic`, … */
  requests?: Record<string, unknown | ((params: unknown) => unknown)>;
  /** Ответы-ошибки по методу: клиент должен получить reject с этим message. */
  errors?: Record<string, string>;
  /** Нотификации, которые сервер «отправит» сам после старта. */
  pushed?: Array<Record<string, unknown>>;
  /** Не отвечать на запрос с таким методом — клиент должен уйти в таймаут. */
  ignore?: string[];
}

/** Процесс-сервер, который можно читать и писать как stdio LSP. */
export class FakeLspServer extends EventEmitter {
  readonly written: string[] = [];
  /** stderr сервера: настоящий поток — буфер растёт, если его не читают. */
  readonly stderr = new PassThrough();
  private buffer = "";
  private nextId = 100;

  constructor(private readonly script: FakeServerScript = {}) {
    super();
  }

  // ── Сторона клиента: он пишет сюда ────────────────────────────────────
  get stdin(): { writable: boolean; write(chunk: string): boolean } {
    return {
      writable: true,
      write: (chunk: string) => {
        this.written.push(chunk);
        this.consume(chunk);
        return true;
      },
    };
  }

  /** Сторона клиента: он читает сюда. */
  writeToClient(message: Record<string, unknown>): void {
    const body = JSON.stringify(message);
    this.emit("data", Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`));
  }

  /** Записать фрейм с LF-разделителем вместо CRLF. */
  writeToClientLf(message: Record<string, unknown>): void {
    const body = JSON.stringify(message);
    this.emit("data", Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\n\n${body}`));
  }

  /** Сэмулировать смерть процесса. */
  die(): void {
    this.emit("exit");
  }

  // ── Внутренний «сервер» ──────────────────────────────────────────────
  private consume(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.buffer);
      if (!match) return;
      const header = this.buffer.slice(0, match.index);
      const len = /content-length:\s*(\d+)/i.exec(header)?.[1];
      if (len === undefined) {
        this.buffer = this.buffer.slice(match.index + match[0].length);
        continue;
      }
      const bodyStart = match.index + match[0].length;
      if (this.buffer.length < bodyStart + Number(len)) return;
      const body = this.buffer.slice(bodyStart, bodyStart + Number(len));
      this.buffer = this.buffer.slice(bodyStart + Number(len));
      this.dispatch(JSON.parse(body) as Record<string, unknown>);
    }
  }

  private dispatch(message: Record<string, unknown>): void {
    const method = typeof message.method === "string" ? message.method : null;
    if (method === null) return;
    const id = typeof message.id === "number" ? message.id : null;
    if (id !== null) this.answerRequest(id, method, message);
    else this.observeNotification(method, message);
  }

  /** Ответ на запрос клиента (или молчание, если метод в `ignore`). */
  private answerRequest(id: number, method: string, message: Record<string, unknown>): void {
    if (this.script.ignore?.includes(method)) return;
    const errorText = this.script.errors?.[method];
    if (errorText !== undefined) {
      this.writeToClient({ jsonrpc: "2.0", id, error: { code: -32601, message: errorText } });
      return;
    }
    const handler = this.script.requests?.[method];
    const result = typeof handler === "function" ? handler(message.params) : (handler ?? null);
    this.writeToClient({ jsonrpc: "2.0", id, result });
    if (method === "initialize") this.pushPushes();
  }

  /** Реакция на нотификацию: на `didOpen` отвечаем пустой диагностикой. */
  private observeNotification(method: string, message: Record<string, unknown>): void {
    if (method !== "textDocument/didOpen") return;
    this.writeToClient({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri: this.lastUri(message), diagnostics: [], version: 1 },
    });
  }

  private pushPushes(): void {
    for (const pushed of this.script.pushed ?? []) this.writeToClient(pushed);
  }

  private lastUri(message: Record<string, unknown>): string {
    const params = message.params as { textDocument?: { uri?: string } } | undefined;
    return params?.textDocument?.uri ?? "";
  }

  /** Запросить у клиента что-либо (server→client request). */
  askClient(method: string, params: unknown = {}): void {
    const id = this.nextId++;
    this.writeToClient({ jsonrpc: "2.0", id, method, params });
    return;
  }
}

/** Фабрика процесса для `LspConnection`: отдаёт заранее созданный сервер. */
export function spawnOf(server: FakeLspServer) {
  return async () =>
    ({
      stdin: server.stdin,
      stdout: server,
      stderr: server.stderr,
      kill: () => true,
      once: (event: "exit", cb: () => void) => {
        server.once(event, cb);
      },
      on: (event: "error", cb: (error: Error) => void) => {
        if (event === "error") server.on("error", cb);
      },
    }) as never;
}

export const frame = (message: Record<string, unknown>, eol = "\r\n"): string => {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body)}${eol}${eol}${body}`;
};

/** Разобрать всё, что клиент написал серверу, в массив JSON-RPC сообщений. */
export function parseWire(chunks: string[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const raw of chunks) {
    let buffer = raw;
    for (;;) {
      const match = /\r?\n\r?\n/.exec(buffer);
      if (!match) break;
      const len = /content-length:\s*(\d+)/i.exec(buffer.slice(0, match.index))?.[1];
      const start = match.index + match[0].length;
      if (len === undefined) {
        buffer = buffer.slice(start);
        continue;
      }
      if (buffer.length < start + Number(len)) break;
      out.push(JSON.parse(buffer.slice(start, start + Number(len))) as Record<string, unknown>);
      buffer = buffer.slice(start + Number(len));
    }
  }
  return out;
}
