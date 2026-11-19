// Строки тела карточки тула: гуттер, захват для Ctrl+O, кап вывода (шов `renderer.ts`).
import type { OutputChannel } from "../output";
import { sanitizeOutput } from "./sanitize-output";

export const GUTTER = "  ";
const MAX_OUTPUT_LINES = 50;
const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** Накопитель тела карточки: полный список (Ctrl+O) и первая строка (футер ошибки). */
export interface BodySink {
  body: string[];
  firstBody: string;
}

/**
 * Пишет строки тела с гуттером и ведёт счётчик капа. В quiet тела не печатаются,
 * но накопитель всё равно заполняется — провалу нужна первая строка.
 */
export class BodyStream {
  private seen = 0;
  private suppressed = false;

  /** Новый тул: счётчики капа сбрасываются. */
  reset(): void {
    this.seen = 0;
    this.suppressed = false;
  }

  /** Сколько строк сверх капа было скрыто (0 — всё влезло). */
  get overflow(): number {
    return this.suppressed ? this.seen - MAX_OUTPUT_LINES : 0;
  }

  write(chunk: string, sink: BodySink | null, quiet: boolean, channel: OutputChannel): void {
    for (const line of chunk.split("\n")) {
      if (line.trim() === "") continue;
      const plain = sanitizeOutput(stripAnsi(line)).trim();
      if (sink) {
        if (sink.body.length < MAX_OUTPUT_LINES) sink.body.push(plain);
        if (!sink.firstBody) sink.firstBody = plain;
      }
      if (quiet) {
        // Первую строку держим, чтобы у провала осталось короткое объяснение, но
        // чат не заливаем: детали — через /verbose и Ctrl+O.
        continue;
      }
      this.seen++;
      if (this.seen > MAX_OUTPUT_LINES) {
        this.suppressed = true;
        continue;
      }
      channel.writeRaw(`${GUTTER}${sanitizeOutput(line)}\n`);
    }
  }
}
