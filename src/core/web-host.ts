/** Хост для `mma web`: без TTY и LineEditor, поверх тех же deps. */
import type {
  Host,
  HostConfigSnapshot,
  HostConfigWriteResult,
  HostEvent,
  HostModels,
  HostStateSnapshot,
} from "./host";
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
  getConfig?: () => HostConfigSnapshot;
  setConfig?: (key: string, value: unknown) => Promise<HostConfigWriteResult>;
  listModels?: (provider?: string) => HostModels;
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

  async getConfig(): Promise<HostConfigSnapshot> {
    return this.deps.getConfig?.() ?? { config: {}, version: 0 };
  }

  async setConfig(key: string, value: unknown): Promise<HostConfigWriteResult> {
    if (!this.deps.setConfig) {
      return { ok: false, persisted: false, error: "config write unavailable" };
    }
    return this.deps.setConfig(key, value);
  }

  async listModels(provider?: string): Promise<HostModels> {
    return this.deps.listModels?.(provider) ?? { models: [] };
  }

  /** Транспорт-нейтральная подписка: локальная шина отдаёт `HostEvent`. */
  subscribeEvents(fn: (ev: HostEvent) => void): () => void {
    return defaultOutputBus.subscribe((ev) => {
      fn({ type: "output", ts: ev.ts, sessionId: ev.sessionId, source: ev.source, data: ev });
    });
  }
}
