import type { OutputEvent, OutputSubscriber } from "./types";

/**
 * Collects bus events so a machine-readable run (`--json`) can include the
 * warn/error diagnostics that the human channel suppresses via `setQuiet`.
 * Info/debug events are ignored: they are progress noise, not diagnostics.
 */
export class JsonOutputSink {
  private events: OutputEvent[] = [];
  private readonly unsub: () => void;

  constructor(bus: { subscribe(fn: OutputSubscriber): () => void }) {
    this.unsub = bus.subscribe((ev) => {
      this.events.push(ev);
    });
  }

  diagnostics(): Array<{ level: string; source: string; text: string }> {
    return this.events
      .filter((e) => e.level === "warn" || e.level === "error")
      .map((e) => ({ level: e.level, source: e.source, text: e.text }));
  }

  dispose(): void {
    this.unsub();
  }
}
