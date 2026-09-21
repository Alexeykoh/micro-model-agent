import { pc } from "./colors";
import stringWidth from "string-width";
import { getTerminalWidth } from "./table";
import type { OutputChannel } from "../output";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface SpinnerOptions {
  enabled?: boolean;
  channel?: OutputChannel;
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
 */
export class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private message = "";
  private enabled: boolean;
  private channel?: OutputChannel;
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

  get running(): boolean {
    return this.timer !== null;
  }

  start(message: string): void {
    if (!this.enabled) return;
    this.stop();
    this.message = this.truncate(message);
    this.frame = 0;
    this.startedAt = Date.now();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.tick();
  }

  setMessage(message: string): void {
    this.message = this.truncate(message);
    if (this.timer) this.tick();
  }

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
    return acc + "…";
  }

  private tick(): void {
    if (!this.timer) return;
    const frame = FRAMES[this.frame % FRAMES.length];
    this.frame++;
    // Show elapsed seconds only once the wait is noticeable — a quiet hint
    // that the tool is still working, not just fast output.
    const elapsed = Date.now() - this.startedAt;
    const suffix = elapsed >= 3000 ? pc.dim(` · ${Math.floor(elapsed / 1000)}s`) : "";
    const text = "\r" + pc.cyan(frame) + " " + this.message + suffix + "\x1b[K";
    if (this.channel) this.channel.writeOverlay(text);
    else this.stream.write(text);
  }
}
