// Спиннер прогресса: одна перезаписываемая строка в stderr (только TTY).
import { pc } from "./colors";
import stringWidth from "string-width";
import { getTerminalWidth } from "./table";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Минимум канала, который нужен спиннеру: перезаписываемая оверлей-строка.
 * Уже, чем `OutputChannel`, поэтому в него попадает и узкий `CommandOutput`
 * фронтенда (TUI перерисовывает оверлей в своей строке статуса).
 */
export interface SpinnerSink {
  writeOverlay(text: string): void;
}

/** Опции спиннера: вкл/выкл, канал, интервал, ширина. */
export interface SpinnerOptions {
  enabled?: boolean;
  channel?: SpinnerSink;
  intervalMs?: number;
  width?: number;
}

/** Поддерживается ли спиннер на потоке (TTY и не CI). */
export function isSpinnerSupported(stream?: NodeJS.WritableStream): boolean {
  const s = stream ?? process.stderr;
  return Boolean((s as { isTTY?: boolean }).isTTY) && !process.env.CI;
}

/**
 * ANSI-спиннер без зависимостей. Пишет в stderr одной перезаписываемой строкой
 * (`\r` + текст + чистка до конца). На не-TTY автоматически выключен.
 */
export class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private message = "";
  private enabled: boolean;
  private channel?: SpinnerSink;
  private stream: NodeJS.WritableStream;
  private intervalMs: number;
  private width: number;
  private startedAt = 0;

  constructor(opts: SpinnerOptions = {}) {
    this.channel = opts.channel;
    this.stream = process.stderr;
    this.enabled = opts.enabled ?? isSpinnerSupported();
    this.intervalMs = opts.intervalMs ?? 80;
    this.width = opts.width ?? getTerminalWidth();
  }

  /** Крутится ли сейчас. */
  get running(): boolean {
    return this.timer !== null;
  }

  /** Обновить ширину терминала (resize): длинные сообщения режутся по ней. */
  setWidth(width: number): void {
    this.width = width;
  }

  /** Старт с сообщением (перезапускает, если уже крутится). */
  start(message: string): void {
    if (!this.enabled) return;
    this.stop();
    this.message = this.truncate(message);
    this.frame = 0;
    this.startedAt = Date.now();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.tick();
  }

  /** Смена сообщения на лету. */
  setMessage(message: string): void {
    this.message = this.truncate(message);
    if (this.timer) this.tick();
  }

  /** Стоп со стиранием строки. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      const clear = "\r\x1b[K";
      if (this.channel) this.channel.writeOverlay(clear);
      else this.stream.write(clear);
    }
  }

  private truncate(text: string): string {
    if (stringWidth(text) <= this.width - 2) return text;
    let acc = "";
    for (const ch of text) {
      if (stringWidth(acc + ch) > this.width - 3) break;
      acc += ch;
    }
    return `${acc}…`;
  }

  private tick(): void {
    if (!this.timer) return;
    const frame = FRAMES[this.frame % FRAMES.length];
    this.frame++;
    // Секунды показываем, лишь когда ожидание заметно: тихий хинт, что тул
    // ещё работает, а не быстрый вывод.
    const elapsed = Date.now() - this.startedAt;
    const suffix = elapsed >= 3000 ? pc.dim(` · ${Math.floor(elapsed / 1000)}s`) : "";
    const text = `\r${pc.cyan(frame)} ${this.message}${suffix}\x1b[K`;
    if (this.channel) this.channel.writeOverlay(text);
    else this.stream.write(text);
  }
}
