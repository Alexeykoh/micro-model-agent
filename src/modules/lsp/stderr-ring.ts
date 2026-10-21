// Кольцо stderr LSP-сервера: последние 4 КБ для диагностики.
//
// Вынесено из `connection.ts`: это буфер, а не логика соединения (правило 6 AGENTS).

/** Сколько байт stderr держим. */
export const STDERR_TAIL_BYTES = 4096;

/** Кольцевой буфер stderr: держит последние байты, старые вытесняются. */
export class StderrRing {
  private buffer = "";

  /** Дописать кусок (старые байты вытесняются). */
  push(chunk: string): void {
    this.buffer = (this.buffer + chunk).slice(-STDERR_TAIL_BYTES);
  }

  /** Текущий хвост. */
  get tail(): string {
    return this.buffer;
  }
}
