import type { OutputBus } from "./bus";
import type { OutputEvent } from "./types";
import type { SessionManager } from "../modules/session/manager";

/**
 * Narrow session-log seam so the sink stays testable without a real manager.
 * Typed via `SessionManager.appendLog` — no `any`, and a real manager is
 * assignable by construction.
 */
export interface SessionLogSink {
  appendLog(entry: Parameters<SessionManager["appendLog"]>[0]): void;
}

/**
 * Persists explicitly marked output events (`data.persist === true`) into the
 * session log. Most output is transient terminal progress and is deliberately
 * NOT persisted; the primary file path for durable records stays
 * `SessionLogger.logSilent` / `logStructured`.
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
        content: ev.text,
      });
    });
  }

  dispose(): void {
    this.unsub();
  }
}
