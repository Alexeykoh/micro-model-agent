// Шина вывода: продюсеры эмитят события, стоки (канал, JSON, сессия) читают.
import type { OutputEvent, OutputLevel, OutputSink, OutputSubscriber } from "./types";

/** Шина событий вывода. Упавший подписчик шину не роняет. */
export class OutputBus implements OutputSink {
  private seq = 0;
  private readonly subs = new Set<OutputSubscriber>();

  /** Подписка; возвращает отписку. */
  subscribe(fn: OutputSubscriber): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  /** Эмит события; проставляет id/ts и возвращает полное событие. */
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

  /** Короткий эмит log-события. */
  log(
    level: OutputLevel,
    source: string,
    text: string,
    data?: Record<string, unknown>,
  ): OutputEvent {
    return this.emit({ level, source, kind: "log", text, data });
  }

  /**
   * Хук изоляции тестов: сбрасывает подписчиков и счётчик id.
   * В прод-коде не вызывать.
   */
  reset(): void {
    this.subs.clear();
    this.seq = 0;
  }
}

/** Шина по умолчанию для всего приложения. */
export const defaultOutputBus = new OutputBus();
