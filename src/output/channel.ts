import { defaultOutputBus, type OutputBus } from "./bus";
import { formatEventLine } from "./format";
import type { OutputEvent, OutputStream } from "./types";

export interface PromptSink {
  isActive(): boolean;
  printAbove(text: string): void;
}

export type ChannelMode = "idle" | "streaming" | "modal" | "quiet";

export interface OutputChannelOptions {
  out?: NodeJS.WritableStream;
  err?: NodeJS.WritableStream;
  color?: boolean;
}

export class OutputChannel {
  private out: NodeJS.WritableStream;
  private err: NodeJS.WritableStream;
  private color: boolean;
  private mode: ChannelMode = "idle";
  private sink: PromptSink | null = null;
  private queue: OutputEvent[] = [];
  private pending: { stream: OutputStream; text: string } | null = null;
  private partialOpen = false;
  private readonly unsub: () => void;

  constructor(
    private bus: OutputBus = defaultOutputBus,
    opts: OutputChannelOptions = {},
  ) {
    this.out = opts.out ?? process.stdout;
    this.err = opts.err ?? process.stderr;
    this.color = opts.color ?? (!process.env.NO_COLOR && !process.env.CI);
    this.unsub = this.bus.subscribe((ev) => this.onEvent(ev));
  }

  dispose(): void {
    this.unsub();
    this.queue = [];
    this.pending = null;
  }

  attachPrompt(sink: PromptSink | null): void {
    this.sink = sink;
  }

  getMode(): ChannelMode {
    return this.mode;
  }

  beginStreaming(): void {
    this.flushPendingAsBlock();
    this.mode = "streaming";
  }

  endStreaming(): void {
    this.closePartial();
    this.mode = "idle";
  }

  beginModal(): void {
    this.flushPendingAsBlock();
    this.mode = "modal";
  }

  endModal(): void {
    this.mode = "idle";
    const q = this.queue;
    this.queue = [];
    for (const ev of q) this.onEvent(ev);
  }

  setQuiet(quiet: boolean): void {
    this.mode = quiet ? "quiet" : "idle";
  }

  writeRaw(text: string, stream: OutputStream = "stdout"): void {
    if (this.mode === "modal" || this.mode === "quiet") return;
    if (this.mode === "idle" && this.sink?.isActive() && stream === "stdout") {
      this.pending = {
        stream,
        text: (this.pending?.stream === stream ? this.pending.text : "") + text,
      };
      this.drainPending(false);
      return;
    }
    if (stream === "stdout") this.partialOpen = !text.endsWith("\n");
    (stream === "stderr" ? this.err : this.out).write(text);
  }

  writeLine(text: string, stream: OutputStream = "stdout"): void {
    this.bus.emit({ level: "info", source: "", kind: "block", text, stream });
  }

  writeOverlay(text: string): void {
    if (this.mode === "modal" || this.mode === "quiet") return;
    if (this.mode === "idle" && this.sink?.isActive()) return;
    this.err.write(text);
  }

  private onEvent(ev: OutputEvent): void {
    if (this.mode === "quiet") return;
    if (this.mode === "modal") {
      this.queue.push(ev);
      return;
    }
    if (ev.kind === "raw") {
      this.writeRaw(ev.text, ev.stream);
      return;
    }
    const stream = ev.stream ?? "stdout";
    const line = ev.kind === "block" ? ev.text : formatEventLine(ev, this.color);
    if (stream === "stdout" && this.mode === "idle" && this.sink?.isActive()) {
      this.flushPendingAsBlock();
      this.sink.printAbove(line);
      return;
    }
    if (this.mode === "streaming") this.closePartial();
    (stream === "stderr" ? this.err : this.out).write(`${line}\n`);
  }

  private closePartial(): void {
    if (this.partialOpen) {
      this.out.write("\n");
      this.partialOpen = false;
    }
  }

  private drainPending(final: boolean): void {
    if (!this.pending) return;
    const { stream, text } = this.pending;
    const idx = final ? text.length : text.lastIndexOf("\n");
    if (idx < 0) return;
    const head = text.slice(0, idx + (final ? 0 : 1));
    this.pending = final ? null : { stream, text: text.slice(idx + 1) };
    const lines = head.replace(/\n$/, "").split("\n");
    if (this.sink?.isActive()) this.sink.printAbove(lines.join("\n"));
    else this.out.write(head);
  }

  private flushPendingAsBlock(): void {
    if (this.pending) {
      const text = this.pending.text;
      const { stream } = this.pending;
      this.pending = null;
      if (this.sink?.isActive()) this.sink.printAbove(text);
      else (stream === "stderr" ? this.err : this.out).write(text);
    }
    this.partialOpen = false;
  }
}

let defaultChannel: OutputChannel | null = null;

export function getDefaultChannel(): OutputChannel {
  if (!defaultChannel) defaultChannel = new OutputChannel(defaultOutputBus);
  return defaultChannel;
}

export function resetDefaultChannel(): void {
  defaultChannel?.dispose();
  defaultChannel = null;
}
