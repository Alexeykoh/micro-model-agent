/**
 * `LocalHost` — in-process реализация контракта `Host` (split W1).
 *
 * Реплика и веб-сервер получают её вместо собственных реализаций `Host`;
 * RemoteHost (W2) реализует тот же интерфейс поверх HTTP+SSE. Здесь нет
 * процесса-глобального состояния в контракте: deps инжектируются, подписка
 * идёт через переданный `subscribeOutput`.
 */
import type { Host, HostEvent, HostStateSnapshot } from "./host";
import type { HostBridgeSubmitOptions } from "../modules/types";
import type { OutputEvent } from "../output/types";

/** Зависимости локального хоста (шина вывода и run-путь владельца). */
export interface LocalHostDeps {
  isBusy(): boolean;
  submit(text: string, opts?: HostBridgeSubmitOptions): Promise<unknown>;
  interrupt(): void;
  subscribeOutput(fn: (ev: OutputEvent) => void): () => void;
  executeCommand(line: string): Promise<void>;
  /** Снапшот может быть синхронным (локальная проекция) или async. */
  getState(sessionId?: string): HostStateSnapshot | Promise<HostStateSnapshot>;
}

/** In-process хост: тот же интерфейс, что у RemoteHost. */
export class LocalHost implements Host {
  constructor(private readonly deps: LocalHostDeps) {}

  isBusy(): boolean {
    return this.deps.isBusy();
  }

  submit(text: string, opts?: HostBridgeSubmitOptions): Promise<unknown> {
    return this.deps.submit(text, opts);
  }

  interrupt(): void {
    this.deps.interrupt();
  }

  subscribeOutput(fn: (ev: OutputEvent) => void): () => void {
    return this.deps.subscribeOutput(fn);
  }

  async getState(sessionId?: string): Promise<HostStateSnapshot> {
    return this.deps.getState(sessionId);
  }

  /**
   * Транспорт-нейтральная подписка: локальная шина отдаёт `OutputEvent`,
   * обёрнутый в единый `HostEvent` (`type: "output"`).
   */
  subscribeEvents(fn: (ev: HostEvent) => void): () => void {
    return this.deps.subscribeOutput((ev) => {
      fn({ type: "output", ts: ev.ts, sessionId: ev.sessionId, source: ev.source, data: ev });
    });
  }

  async executeCommand(line: string): Promise<void> {
    await this.deps.executeCommand(line);
  }
}
