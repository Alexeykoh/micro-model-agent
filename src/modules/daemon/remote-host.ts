/**
 * `RemoteHost` — тонкий клиент контракта `Host` поверх `/v1/host/*` (split W2).
 *
 * Клиент не конструирует `Agent`/`SessionManager` и не владеет workspace:
 * состояние, ходы и вопросы живут в демоне. События приходят по SSE из
 * `GET /v1/host/sessions/:id/stream`; форма — `HostEvent`, `data` — envelope v1.
 */
import type {
  Host,
  HostCommandResult,
  HostConfigSnapshot,
  HostConfigWriteResult,
  HostEvent,
  HostModels,
  HostStateSnapshot,
} from "../../core/host";
import type { HostBridgeSubmitOptions } from "../types";
import type { SessionLogEntry } from "../session/log-types";
import type { SessionMessage, SessionMeta } from "../session/types";

/** Параметры подключения: адрес демона, сессия, bearer-токен. */
export interface RemoteHostOptions {
  baseUrl: string;
  sessionId?: string;
  token?: string | null;
}

/** События, после которых ход сессии завершён (busy снимается). */
const TERMINAL_TYPES = new Set(["task.finished", "task.failed", "task.cancelled"]);

/** Тонкий UI-клиент: только wire, без собственной логики хода. */
export class RemoteHost implements Host {
  private readonly listeners = new Set<(ev: HostEvent) => void>();
  private activeSession?: string;
  private busy = false;
  private lastSeq = 0;
  private stream?: { controller: AbortController };

  constructor(private readonly opts: RemoteHostOptions) {
    this.activeSession = opts.sessionId;
  }

  setSessionId(sessionId: string): void {
    this.activeSession = sessionId;
  }

  isBusy(): boolean {
    return this.busy;
  }

  async getState(sessionId: string | undefined = this.activeSession): Promise<HostStateSnapshot> {
    const res = await this.request(`${this.base}/v1/host/state${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ""}`);
    if (!res.ok) throw new Error(`daemon state failed: ${res.status} ${await safeText(res)}`);
    const body = (await res.json()) as { state?: HostStateSnapshot };
    return body.state ?? { busy: this.busy };
  }

  async submit(text: string, o?: HostBridgeSubmitOptions): Promise<unknown> {
    const res = await this.request(this.sessionUrl("submit"), {
      method: "POST",
      body: JSON.stringify({
        text,
        ...(o?.images?.length ? { images: o.images } : {}),
      }),
    });
    if (!res.ok) throw new Error(`daemon submit failed: ${res.status} ${await safeText(res)}`);
    this.busy = true;
    this.ensureStream();
    return res.json();
  }

  interrupt(): void {
    void this.request(this.sessionUrl("interrupt"), { method: "POST" }).catch(() => {});
  }

  /** `POST .../pause` — durable-пауза на демоне. */
  async pause(): Promise<void> {
    await this.control("pause");
  }

  /** `POST .../resume` — снять паузу. */
  async resume(): Promise<void> {
    await this.control("resume");
  }

  /** `POST .../answer` — ответ на висящий вопрос хода. */
  async answer(id: string, value: unknown): Promise<void> {
    const res = await this.request(this.sessionUrl("answer"), {
      method: "POST",
      body: JSON.stringify({ id, answer: value }),
    });
    if (!res.ok) throw new Error(`daemon answer failed: ${res.status} ${await safeText(res)}`);
  }

  async executeCommand(line: string): Promise<HostCommandResult> {
    const res = await this.request(this.sessionUrl("command"), {
      method: "POST",
      body: JSON.stringify({ line }),
    });
    if (!res.ok) throw new Error(`daemon command failed: ${res.status} ${await safeText(res)}`);
    return (await res.json()) as HostCommandResult;
  }

  async listSessions(): Promise<SessionMeta[]> {
    const res = await this.request(`${this.base}/v1/host/sessions`);
    if (!res.ok) throw new Error(`daemon sessions failed: ${res.status} ${await safeText(res)}`);
    const body = (await res.json()) as { sessions?: SessionMeta[] };
    return body.sessions ?? [];
  }

  async createSession(name?: string): Promise<SessionMeta> {
    const res = await this.request(`${this.base}/v1/host/sessions`, {
      method: "POST",
      body: JSON.stringify(name !== undefined ? { name } : {}),
    });
    if (!res.ok) throw new Error(`daemon create session failed: ${res.status} ${await safeText(res)}`);
    return (await res.json()) as SessionMeta;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const res = await this.request(`${this.base}/v1/host/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error(`daemon delete session failed: ${res.status} ${await safeText(res)}`);
  }

  async getHistory(sessionId: string): Promise<SessionMessage[]> {
    const res = await this.request(
      `${this.base}/v1/host/sessions/${encodeURIComponent(sessionId)}/history`,
    );
    if (!res.ok) throw new Error(`daemon history failed: ${res.status} ${await safeText(res)}`);
    const body = (await res.json()) as { messages?: SessionMessage[] };
    return body.messages ?? [];
  }

  async getLog(
    sessionId: string,
    opts: { since?: string; limit?: number } = {},
  ): Promise<SessionLogEntry[]> {
    const query = new URLSearchParams();
    if (opts.since !== undefined) query.set("since", opts.since);
    if (opts.limit !== undefined) query.set("limit", String(opts.limit));
    const suffix = query.size ? `?${query.toString()}` : "";
    const res = await this.request(
      `${this.base}/v1/host/sessions/${encodeURIComponent(sessionId)}/log${suffix}`,
    );
    if (!res.ok) throw new Error(`daemon log failed: ${res.status} ${await safeText(res)}`);
    const body = (await res.json()) as { entries?: SessionLogEntry[] };
    return body.entries ?? [];
  }

  async listFiles(path: string): Promise<unknown> {
    const res = await this.request(`${this.base}/v1/host/files${path ? `?path=${encodeURIComponent(path)}` : ""}`);
    if (!res.ok) throw new Error(`daemon files failed: ${res.status} ${await safeText(res)}`);
    return res.json();
  }

  async getConfig(): Promise<HostConfigSnapshot> {
    const res = await this.request(`${this.base}/v1/host/config`);
    if (!res.ok) throw new Error(`daemon config failed: ${res.status} ${await safeText(res)}`);
    return (await res.json()) as HostConfigSnapshot;
  }

  async setConfig(key: string, value: unknown): Promise<HostConfigWriteResult> {
    const res = await this.request(`${this.base}/v1/host/config`, {
      method: "POST",
      body: JSON.stringify({ key, value }),
    });
    if (res.status === 200) return (await res.json()) as HostConfigWriteResult;
    const detail = await safeText(res);
    return { ok: false, persisted: false, error: `daemon config write failed: ${res.status} ${detail}` };
  }

  async listModels(provider?: string): Promise<HostModels> {
    const suffix = provider ? `?provider=${encodeURIComponent(provider)}` : "";
    const res = await this.request(`${this.base}/v1/host/models${suffix}`);
    if (!res.ok) throw new Error(`daemon models failed: ${res.status} ${await safeText(res)}`);
    return (await res.json()) as HostModels;
  }

  subscribeEvents(fn: (ev: HostEvent) => void): () => void {
    this.listeners.add(fn);
    this.ensureStream();
    return () => {
      this.listeners.delete(fn);
    };
  }

  dispose(): void {
    this.stream?.controller.abort();
    this.stream = undefined;
  }

  private get base(): string {
    return this.opts.baseUrl.replace(/\/+$/, "");
  }

  private get sessionId(): string {
    if (!this.activeSession) throw new Error("no session selected");
    return this.activeSession;
  }

  private sessionUrl(action: string): string {
    return `${this.base}/v1/host/sessions/${encodeURIComponent(this.sessionId)}/${action}`;
  }

  private async control(action: string): Promise<void> {
    const res = await this.request(this.sessionUrl(action), { method: "POST" });
    if (!res.ok) throw new Error(`daemon ${action} failed: ${res.status} ${await safeText(res)}`);
  }

  private request(url: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    };
    if (this.opts.token) headers.Authorization = `Bearer ${this.opts.token}`;
    return fetch(url, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(30_000) });
  }

  /** Лениво поднимает SSE-поток; повторный вызов после закрытия — новый. */
  private ensureStream(): void {
    if (this.stream) return;
    const controller = new AbortController();
    this.stream = { controller };
    void this.runStream(controller.signal).finally(() => {
      if (this.stream?.controller === controller) this.stream = undefined;
    });
  }

  private async runStream(signal: AbortSignal): Promise<void> {
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (this.opts.token) headers.Authorization = `Bearer ${this.opts.token}`;
    if (this.lastSeq > 0) headers["Last-Event-ID"] = String(this.lastSeq);
    let res: Response;
    try {
      res = await fetch(this.sessionUrl("stream"), { headers, signal });
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
      /* поток закрыт клиентом или сетью — следующий вызов откроет новый */
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
    const type = env.type ?? "output";
    if (TERMINAL_TYPES.has(type)) this.busy = false;
    if (type === "task.started") this.busy = true;
    const event: HostEvent = {
      type,
      ts: env.ts ?? Date.now(),
      ...(env.sessionId ? { sessionId: env.sessionId } : {}),
      ...(env.data !== undefined ? { data: env.data } : {}),
    };
    for (const fn of this.listeners) fn(event);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
