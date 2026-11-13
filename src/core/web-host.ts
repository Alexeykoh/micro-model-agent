/** Хост для `mma web`: без TTY и LineEditor, поверх тех же deps. */
import type { Host, HostEvent, HostStateSnapshot } from "./host";
import type { HostBridgeSubmitOptions } from "../modules/types";
import type { OutputEvent } from "../output/types";
import { defaultOutputBus } from "../output/bus";

/** Зависимости веб-хоста: запуск агента, состояние, команды, картинки. */
export interface WebHostDeps {
  runAgent: (text: string) => Promise<unknown>;
  isBusy: () => boolean;
  interrupt: () => void;
  executeCommand: (line: string) => Promise<void>;
  getState: (sessionId?: string) => HostStateSnapshot;
  addPendingImage?: (dataUrl: string) => void;
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

  /** Транспорт-нейтральная подписка: локальная шина отдаёт `HostEvent`. */
  subscribeEvents(fn: (ev: HostEvent) => void): () => void {
    return defaultOutputBus.subscribe((ev) => {
      fn({ type: "output", ts: ev.ts, sessionId: ev.sessionId, source: ev.source, data: ev });
    });
  }
}
