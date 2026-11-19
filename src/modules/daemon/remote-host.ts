/**
 * `RemoteHost` — тонкий клиент контракта `Host` поверх `/v1/host/*` (split W2).
 *
 * Клиент не конструирует `Agent`/`SessionManager` и не владеет workspace:
 * состояние, ходы и вопросы живут в демоне. События приходят по SSE из
 * `GET /v1/host/sessions/:id/stream`; форма — `HostEvent`, `data` — envelope v1.
 *
 * Панельные запросы (files/git/security/subagents/…) — в `RemotePanelClient`
 * (`remote-host-panels.ts`), чтобы файл оставался про контракт `Host`.
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
import { RemoteEventStream } from "./remote-host-events";
import { RemoteSettingsClient } from "./remote-host-settings";
import { TERMINAL_TYPES, safeText, type RemoteHostOptions } from "./remote-host-types";
import type { SessionMessage, SessionMeta } from "../session/types";

export type { RemoteHostOptions } from "./remote-host-types";

/** Тонкий UI-клиент: только wire, без собственной логики хода. */
export class RemoteHost extends RemoteSettingsClient implements Host {
  private activeSession?: string;
  private busy = false;
  private readonly events: RemoteEventStream;

  constructor(opts: RemoteHostOptions) {
    super(opts);
    this.activeSession = opts.sessionId;
    this.events = new RemoteEventStream({
      streamUrl: () => this.sessionUrl("stream"),
      token: opts.token,
      locale: this.locale,
      onEvent: (ev) => this.trackBusy(ev),
    });
  }

  setSessionId(sessionId: string): void {
    this.activeSession = sessionId;
  }

  isBusy(): boolean {
    return this.busy;
  }

  async getState(sessionId: string | undefined = this.activeSession): Promise<HostStateSnapshot> {
    const res = await this.request(
      `${this.base}/v1/host/state${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ""}`,
    );
    if (!res.ok) throw new Error(`daemon state failed: ${res.status} ${await safeText(res)}`);
    const body = (await res.json()) as { state?: HostStateSnapshot };
    return body.state ?? { busy: this.busy };
  }

  async submit(text: string, o?: HostBridgeSubmitOptions): Promise<unknown> {
    // Вкладка шлёт ход в свою сессию, не переключая «активную» у соседей.
    if (o?.sessionId) this.setSessionId(o.sessionId);
    const res = await this.request(this.sessionUrl("submit"), {
      method: "POST",
      body: JSON.stringify({
        text,
        ...(o?.images?.length ? { images: o.images } : {}),
        ...(o?.clientTz ? { clientTz: o.clientTz } : {}),
      }),
    });
    if (!res.ok) throw new Error(`daemon submit failed: ${res.status} ${await safeText(res)}`);
    this.busy = true;
    this.events.ensure();
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
    if (!res.ok) {
      throw new Error(`daemon create session failed: ${res.status} ${await safeText(res)}`);
    }
    return (await res.json()) as SessionMeta;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const res = await this.request(
      `${this.base}/v1/host/sessions/${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      throw new Error(`daemon delete session failed: ${res.status} ${await safeText(res)}`);
    }
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
    return this.events.subscribe(fn);
  }

  dispose(): void {
    this.events.dispose();
  }

  private trackBusy(ev: HostEvent): void {
    if (TERMINAL_TYPES.has(ev.type)) this.busy = false;
    else if (ev.type === "task.started") this.busy = true;
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
}
