import type { OutputEvent, OutputLevel, OutputSink, OutputSubscriber } from "./types";

export class OutputBus implements OutputSink {
  private seq = 0;
  private readonly subs = new Set<OutputSubscriber>();

  subscribe(fn: OutputSubscriber): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  emit(ev: Omit<OutputEvent, "id" | "ts">): OutputEvent {
    const full: OutputEvent = { ...ev, id: ++this.seq, ts: Date.now() };
    for (const fn of [...this.subs]) {
      try {
        fn(full);
      } catch {
        /* a subscriber must not break the bus */
      }
    }
    return full;
  }

  log(
    level: OutputLevel,
    source: string,
    text: string,
    data?: Record<string, unknown>,
  ): OutputEvent {
    return this.emit({ level, source, kind: "log", text, data });
  }

  /**
   * Test-isolation / rare-use hook: drops all subscribers and restarts the id sequence.
   * Do not call this in production code paths.
   */
  reset(): void {
    this.subs.clear();
    this.seq = 0;
  }
}

export const defaultOutputBus = new OutputBus();
