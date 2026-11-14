/**
 * SSE-поток событий демона для `RemoteHost` (split W4/W8, правило ≤300).
 *
 * Класс держит одно соединение, resume по `Last-Event-ID`, разбор envelope v1
 * и набор слушателей. Обрыв сети/потока не убивает подписку: клиент
 * переподключается с backoff, пока его не закрыли через `dispose()`.
 */
import type { HostEvent } from "../../core/host";

/** Опции потока: адрес, токен, хук события и тестовые швы. */
export interface RemoteEventStreamOptions {
  streamUrl: () => string;
  token?: string | null;
  onEvent?: (ev: HostEvent) => void;
  /** Пауза перед переподключением (мс); дефолт 1000. */
  retryMs?: number;
  /** Тестовый шов подмены сети. */
  fetchImpl?: typeof fetch;
}

/** Подписка на SSE демона с ленивым соединением и авто-реконнектом. */
export class RemoteEventStream {
  private readonly listeners = new Set<(ev: HostEvent) => void>();
  private readonly fetchImpl: typeof fetch;
  private lastSeq = 0;
  private stream?: { controller: AbortController };
  private disposed = false;

  constructor(private readonly opts: RemoteEventStreamOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Подписка; соединение поднимается при первом слушателе. */
  subscribe(fn: (ev: HostEvent) => void): () => void {
    this.listeners.add(fn);
    this.ensure();
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Поднять соединение без слушателя (нужно после submit). */
  ensure(): void {
    if (this.stream || this.disposed) return;
    const controller = new AbortController();
    this.stream = { controller };
    void this.run(controller.signal).finally(() => {
      if (this.stream?.controller === controller) this.stream = undefined;
    });
  }

  /** Закрыть поток; после этого авто-реконнект не поднимается. */
  dispose(): void {
    this.disposed = true;
    this.stream?.controller.abort();
    this.stream = undefined;
  }

  /** Один цикл жизни: connect → обрыв → пауза → reconnect, пока живы. */
  private async run(signal: AbortSignal): Promise<void> {
    const retryMs = this.opts.retryMs ?? 1000;
    while (!signal.aborted) {
      await this.connect(signal);
      if (signal.aborted) return;
      await sleep(retryMs, signal);
    }
  }

  /** Одно SSE-соединение; возвращает управление на обрыве или закрытии. */
  private async connect(signal: AbortSignal): Promise<void> {
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (this.opts.token) headers.Authorization = `Bearer ${this.opts.token}`;
    if (this.lastSeq > 0) headers["Last-Event-ID"] = String(this.lastSeq);
    let res: Response;
    try {
      res = await this.fetchImpl(this.opts.streamUrl(), { headers, signal });
    } catch {
      return;
    }
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let cut = buf.indexOf("\n\n");
        while (cut >= 0) {
          this.handleFrame(buf.slice(0, cut));
          buf = buf.slice(cut + 2);
          cut = buf.indexOf("\n\n");
        }
      }
    } catch {
      /* поток закрыт клиентом или сетью — reconnect сделает следующий виток */
    }
  }

  /** Разбирает SSE-фрейм: `id:` → seq, `data:` → envelope v1. */
  private handleFrame(frame: string): void {
    let id = 0;
    const data: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("id:")) id = Number(line.slice(3).trim());
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (!data.length) return;
    let env: { type?: string; ts?: number; sessionId?: string; seq?: number; data?: unknown };
    try {
      env = JSON.parse(data.join("\n")) as typeof env;
    } catch {
      return;
    }
    if (typeof env.seq === "number") this.lastSeq = Math.max(this.lastSeq, env.seq);
    else if (Number.isFinite(id)) this.lastSeq = Math.max(this.lastSeq, id);
    const event: HostEvent = {
      type: env.type ?? "output",
      ts: env.ts ?? Date.now(),
      ...(env.sessionId ? { sessionId: env.sessionId } : {}),
      ...(env.data !== undefined ? { data: env.data } : {}),
    };
    this.opts.onEvent?.(event);
    for (const fn of this.listeners) fn(event);
  }
}

/** Пауза, прерываемая `dispose()` без висящего таймера. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
