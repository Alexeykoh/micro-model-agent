import { pc } from "./colors";
import stringWidth from "string-width";
import { getTerminalWidth } from "./table";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface SpinnerOptions {
  enabled?: boolean;
  stream?: NodeJS.WritableStream;
  intervalMs?: number;
  width?: number;
}

export function isSpinnerSupported(stream?: NodeJS.WritableStream): boolean {
  const s = stream ?? process.stderr;
  return Boolean((s as any).isTTY) && !process.env.CI;
}

/**
 * Zero-dependency ANSI spinner. Writes to stderr using a single
 * overwritten line (`\r` + text + clear-to-end). Disabled automatically
 * when the target stream is not a TTY.
 *
 * Supports:
 * - topBar mode: renders context bar at terminal line 1 (save/restore cursor)
 * - extra text: right-aligned context info appended to the spinner line
 * - non-animated mode: static display without frame animation
 */
export class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private message = "";
  private enabled: boolean;
  private stream: NodeJS.WritableStream;
  private intervalMs: number;
  private width: number;
  private topBar = false;
  private extraText = "";

  constructor(opts: SpinnerOptions = {}) {
    this.stream = opts.stream ?? process.stderr;
    this.enabled = opts.enabled ?? isSpinnerSupported(this.stream);
    this.intervalMs = opts.intervalMs ?? 80;
    this.width = opts.width ?? getTerminalWidth();
  }

  get running(): boolean {
    return this.timer !== null;
  }

  start(message: string): void {
    if (!this.enabled) return;
    this.stop();
    this.message = this.truncate(message);
    this.frame = 0;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.tick();
  }

  setMessage(message: string): void {
    this.message = this.truncate(message);
    if (this.timer) this.tick();
  }

  setTopBar(enable: boolean): void {
    this.topBar = enable;
  }

  setExtra(text: string): void {
    this.extraText = text;
    if (this.timer) this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      if (this.topBar) {
        // Clear top bar line
        this.stream.write("\x1B[s\x1B[1;1H\x1B[K\x1B[u");
      } else {
        this.stream.write("\r\x1b[K");
      }
      this.topBar = false;
    }
  }

  private truncate(text: string): string {
    if (stringWidth(text) <= this.width - 2) return text;
    let acc = "";
    for (const ch of text) {
      if (stringWidth(acc + ch) > this.width - 3) break;
      acc += ch;
    }
    return acc + "…";
  }

  private tick(): void {
    if (!this.timer) return;
    const frame = FRAMES[this.frame % FRAMES.length];
    this.frame++;

    if (this.topBar) {
      // Top-bar mode: context bar at terminal line 1
      const extra = this.extraText ? `  │  ${this.extraText}` : "";
      const bar = `${pc.cyan(frame)} ${this.message}${extra}`;
      this.stream.write(`\x1B[s\x1B[1;1H\x1B[K${bar}\x1B[u`);
    } else {
      // Normal mode: spinner on current line
      const extra = this.extraText ? `  │  ${this.extraText}` : "";
      const line = `${pc.cyan(frame)} ${this.message}${extra}`;
      this.stream.write(`\r${line}\x1b[K`);
    }
  }
}
