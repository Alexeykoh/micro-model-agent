import type { OutputEvent, OutputSubscriber } from "./types";

/**
 * Копит события шины, чтобы машиночитаемый прогон (`--json`) включил
 * warn/error-диагностику, которую человеческий канал гасит через `setQuiet`.
 * Info/debug игнорируются: это шум прогресса, а не диагностика.
 */
/** Сток warn/error-диагностики для `--json`. @param bus шина для подписки. */
export class JsonOutputSink {
  private events: OutputEvent[] = [];
  private readonly unsub: () => void;

  constructor(bus: { subscribe(fn: OutputSubscriber): () => void }) {
    this.unsub = bus.subscribe((ev) => {
      this.events.push(ev);
    });
  }

  /** Только warn/error события в виде плоских записей. */
  diagnostics(): Array<{ level: string; source: string; text: string }> {
    return this.events
      .filter((e) => e.level === "warn" || e.level === "error")
      .map((e) => ({ level: e.level, source: e.source, text: e.text }));
  }

  dispose(): void {
    this.unsub();
  }
}
