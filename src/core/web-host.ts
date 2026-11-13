/** Хост для `mma web`: без TTY и LineEditor, поверх тех же deps. */
import type { Host, HostEvent, HostStateSnapshot } from "./host";
import type { HostBridgeSubmitOptions } from "../modules/types";
import type { OutputEvent } from "../output/types";
import { defaultOutputBus } from "../output/bus";
import type { SessionLogEntry } from "../modules/session/log-types";
import type { SessionMessage, SessionMeta } from "../modules/session/types";

/** Узкое подмножество SessionManager для host-поверхности web. */
export interface WebHostSessions {
  list(): SessionMeta[];
  create(name?: string): SessionMeta;
  delete(id: string): void;
  getHistory(id: string): SessionMessage[];
  loadSessionLog(id: string, opts?: { since?: string }): SessionLogEntry[];
}

/** Зависимости веб-хоста: запуск агента, состояние, команды, картинки. */
export interface WebHostDeps {
  runAgent: (text: string) => Promise<unknown>;
  isBusy: () => boolean;
  interrupt: () => void;
  executeCommand: (line: string) => Promise<void>;
  getState: (sessionId?: string) => HostStateSnapshot;
  addPendingImage?: (dataUrl: string) => void;
  /** Опционален: у тестового стаба сессий может не быть. */
  sessions?: WebHostSessions;
}

/** Реализация хоста для `mma web` — без TTY, без LineEditor. */
export class WebHost implements Host {
  constructor(private deps: WebHostDeps) {}

  isBusy(): boolean {
    return this.deps.isBusy();
  }

  async submit(text: string, o?: HostBridgeSubmitOptions): Promise<unknown> {
    if (this.deps.isBusy()) throw new Error("agent is busy");
    for (const url of o?.images ?? []) this.deps.addPendingImage?.(url);
    return this.deps.runAgent(text);
  }

  interrupt(): void {
    if (this.deps.isBusy()) this.deps.interrupt();
  }

  subscribeOutput(fn: (ev: OutputEvent) => void): () => void {
    return defaultOutputBus.subscribe(fn);
  }

  async executeCommand(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed.startsWith("/")) return;
    await this.deps.executeCommand(trimmed);
  }

  async getState(sessionId?: string): Promise<HostStateSnapshot> {
    return this.deps.getState(sessionId);
  }

  async listSessions(): Promise<SessionMeta[]> {
    return this.deps.sessions?.list() ?? [];
  }

  async createSession(name?: string): Promise<SessionMeta> {
    if (!this.deps.sessions) throw new Error("sessions unavailable");
    return this.deps.sessions.create(name);
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.deps.sessions?.delete(sessionId);
  }

  async getHistory(sessionId: string): Promise<SessionMessage[]> {
    return this.deps.sessions?.getHistory(sessionId) ?? [];
  }

  async getLog(sessionId: string, opts?: { since?: string; limit?: number }): Promise<SessionLogEntry[]> {
    const entries = this.deps.sessions?.loadSessionLog(sessionId, opts) ?? [];
    return opts?.limit ? entries.slice(-opts.limit) : entries;
  }

  /** Транспорт-нейтральная подписка: локальная шина отдаёт `HostEvent`. */
  subscribeEvents(fn: (ev: HostEvent) => void): () => void {
    return defaultOutputBus.subscribe((ev) => {
      fn({ type: "output", ts: ev.ts, sessionId: ev.sessionId, source: ev.source, data: ev });
    });
  }
}
