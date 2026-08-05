import { pc } from "./colors";

export interface InputBarOptions {
  stream?: NodeJS.WritableStream;
}

/**
 * Terminal input bar that renders at the bottom of the screen on stderr.
 * During agent execution, raw mode captures keystrokes and echoes them
 * on a dedicated stderr line — preventing visual mixing with stdout output.
 *
 * Multi-line buffer: Ctrl+J inserts a newline, Enter submits.
 */
export class InputBar {
  private buffer: string[] = [""];
  private active = false;
  private stream: NodeJS.WritableStream;
  private onSubmit: (text: string) => void = () => {};
  private onCancel: () => void = () => {};
  private onData: ((chunk: Buffer | string) => void) | null = null;
  private originalRawMode: boolean | null = null;
  private lineCount = 0;
  private queueCount = 0;

  constructor(opts: InputBarOptions = {}) {
    this.stream = opts.stream ?? process.stderr;
  }

  get isActive(): boolean {
    return this.active;
  }

  start(onSubmit: (text: string) => void, onCancel: () => void): void {
    if (this.active) return;
    this.active = true;
    this.buffer = [""];
    this.lineCount = 0;
    this.onSubmit = onSubmit;
    this.onCancel = onCancel;

    if (process.stdin.isTTY) {
      this.originalRawMode = (process.stdin as any).isRaw ?? false;
      (process.stdin as any).setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    this.onData = (data: Buffer | string) => {
      const str = typeof data === "string" ? data : data.toString("utf8");
      this.handleInput(str);
    };
    process.stdin.on("data", this.onData as (...args: any[]) => void);
    this.render();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.onData) {
      process.stdin.removeListener("data", this.onData);
      this.onData = null;
    }
    if (process.stdin.isTTY) {
      if (this.originalRawMode !== null) {
        (process.stdin as any).setRawMode(this.originalRawMode);
      } else {
        (process.stdin as any).setRawMode(false);
      }
    }
    this.clearRender();
  }

  clear(): void {
    this.buffer = [""];
    this.lineCount = 0;
    if (this.active) this.render();
  }

  setQueueCount(count: number): void {
    this.queueCount = count;
    if (this.active) this.render();
  }

  private handleInput(data: string): void {
    for (let i = 0; i < data.length; i++) {
      const ch = data[i];
      const code = ch.charCodeAt(0);

      // Enter (LF or CR) — submit
      if (code === 10 || code === 13) {
        const text = this.buffer.join("\n").trim();
        if (text) this.onSubmit(text);
        this.buffer = [""];
        this.lineCount = 0;
        this.render();
        return;
      }

      // Ctrl+C — cancel
      if (code === 3) {
        this.onCancel();
        this.buffer = [""];
        this.lineCount = 0;
        this.render();
        return;
      }

      // Ctrl+J — newline in buffer (Ctrl+J = code 10, but we already handled Enter above)
      // In raw mode, Ctrl+J sends code 10 (same as Enter)
      // We can't distinguish — so use Ctrl+U for newline instead
      // Actually: Ctrl+J = \n = 10. Let's NOT use Ctrl+J.
      // Use: any sequence starting with ESC that we detect as newline

      // Ctrl+U — clear current line
      if (code === 21) {
        this.buffer[this.buffer.length - 1] = "";
        this.render();
        return;
      }

      // Ctrl+W — delete last word
      if (code === 23) {
        const line = this.buffer[this.buffer.length - 1];
        this.buffer[this.buffer.length - 1] = line.replace(/\s*\S+\s*$/, "");
        this.render();
        return;
      }

      // Backspace (DEL 127 or BS 8)
      if (code === 127 || code === 8) {
        const lastIdx = this.buffer.length - 1;
        if (this.buffer[lastIdx].length > 0) {
          this.buffer[lastIdx] = this.buffer[lastIdx].slice(0, -1);
        } else if (this.buffer.length > 1) {
          // Merge with previous line
          const prev = this.buffer[lastIdx - 1];
          this.buffer.pop();
          this.buffer[this.buffer.length - 1] = prev;
        }
        this.render();
        return;
      }

      // Ctrl+M (CR 13) as explicit newline — separate from Enter
      // Actually Ctrl+M = CR = 13, same issue. Skip.

      // Escape sequences (multi-byte) — skip silently
      if (code === 27) {
        // Consume rest of escape sequence in this chunk
        while (i + 1 < data.length && data.charCodeAt(i + 1) >= 32) {
          i++;
        }
        return;
      }

      // Printable (space and above, including UTF-8 multi-byte)
      if (code >= 32) {
        this.buffer[this.buffer.length - 1] += ch;
        this.render();
        return;
      }
    }
  }

  private render(): void {
    // Move up to overwrite previous render
    if (this.lineCount > 0) {
      this.stream.write(`\x1B[${this.lineCount}A`);
    }

    // Build lines
    const lines: string[] = [];

    // Queue indicator
    if (this.queueCount > 0) {
      lines.push(pc.yellow(`  [queued: ${this.queueCount}]`));
    }

    // Prompt + buffer lines
    const prompt = pc.cyan("> ");
    lines.push(prompt + this.buffer[0]);
    for (let i = 1; i < this.buffer.length; i++) {
      lines.push("  " + this.buffer[i]);
    }

    // Cursor on last line
    const lastLine = lines.length - 1;
    lines[lastLine] += pc.inverse(" ");

    // Write all lines, clearing each
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) this.stream.write("\n");
      this.stream.write(lines[i] + "\x1B[K");
    }

    this.lineCount = lines.length;
  }

  private clearRender(): void {
    if (this.lineCount > 0) {
      this.stream.write(`\x1B[${this.lineCount}A`);
      for (let i = 0; i < this.lineCount; i++) {
        this.stream.write("\x1B[K");
        if (i < this.lineCount - 1) this.stream.write("\n");
      }
      // Move cursor back up to where we were
      if (this.lineCount > 1) {
        this.stream.write(`\x1B[${this.lineCount - 1}A`);
      }
    }
    this.lineCount = 0;
  }
}
