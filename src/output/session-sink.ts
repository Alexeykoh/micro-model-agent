import type { OutputBus } from "./bus";
import type { OutputEvent } from "./types";
import { moduleOf } from "./source";
import type { SessionManager } from "../modules/session/manager";

/**
 * Узкий шов с логом сессии — сток остаётся тестируемым без реального менеджера.
 * Типизирован через `SessionManager.appendLog`: без `any`, реальный менеджер
 * присваиваем по построению.
 */
export interface SessionLogSink {
  appendLog(entry: Parameters<SessionManager["appendLog"]>[0]): void;
}

/**
 * Сохраняет в лог сессии только явно помеченные события (`data.persist === true`).
 * Остальной вывод — транзиентный прогресс терминала и осознанно НЕ персистится;
 * основной файловый путь долговечных записей — `SessionLogger.logSilent` /
 * `logStructured`.
 */
export class SessionOutputSink {
  private readonly unsub: () => void;

  constructor(
    bus: OutputBus,
    private session: SessionLogSink,
  ) {
    this.unsub = bus.subscribe((ev: OutputEvent) => {
      if (ev.data?.persist !== true) return;
      this.session.appendLog({
        ts: new Date(ev.ts).toISOString(),
        type: "output",
        level: ev.level,
        source: ev.source,
        module: moduleOf(ev.source),
        content: ev.text,
      });
    });
  }

  dispose(): void {
    this.unsub();
  }
}
