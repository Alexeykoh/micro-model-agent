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
  private modeBeforeQuiet: ChannelMode = "idle";
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
    const outTTY = (this.out as { isTTY?: boolean }).isTTY === true;
    this.color = opts.color ?? (!process.env.NO_COLOR && !process.env.CI && outTTY);
    this.unsub = this.bus.subscribe((ev) => this.onEvent(ev));
  }

  dispose(): void {
    this.unsub();
    this.queue = [];
    this.pending = null;
    this.partialOpen = false;
    this.sink = null;
    this.mode = "idle";
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
    if (quiet) {
      if (this.mode !== "quiet") {
        this.modeBeforeQuiet = this.mode;
        this.mode = "quiet";
      }
    } else if (this.mode === "quiet") {
      this.mode = this.modeBeforeQuiet;
    }
  }

  writeRaw(text: string, stream: OutputStream = "stdout"): void {
    // modal intentionally drops direct writes: the Renderer never runs during a modal prompt.
    if (this.mode === "modal" || this.mode === "quiet") return;
    if (this.mode === "idle" && this.sink?.isActive() && stream === "stdout") {
      const prev = this.pending?.stream === "stdout" ? this.pending.text : "";
      this.pending = { stream, text: prev + text };
      this.drainPending();
      return;
    }
    if (stream === "stdout") this.partialOpen = !text.endsWith("\n");
    (stream === "stderr" ? this.err : this.out).write(text);
  }

  writeLine(text: string, stream: OutputStream = "stdout"): void {
    this.bus.emit({ level: "info", source: "", kind: "block", text, stream });
  }

  writeOverlay(text: string): void {
    // modal intentionally drops overlays: the Renderer never runs during a modal prompt.
    // Task 6's Spinner must stop before any log so an overlay never shares a row with a log line.
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

  private drainPending(): void {
    if (!this.pending) return;
    const { stream, text } = this.pending;
    const idx = text.lastIndexOf("\n");
    if (idx < 0) return;
    const head = text.slice(0, idx + 1);
    this.pending = { stream, text: text.slice(idx + 1) };
    const lines = head.replace(/\n$/, "").split("\n");
    if (this.sink?.isActive()) this.sink.printAbove(lines.join("\n"));
    else this.out.write(head);
  }

  private flushPendingAsBlock(): void {
    if (!this.pending) return;
    const text = this.pending.text;
    const { stream } = this.pending;
    this.pending = null;
    if (this.sink?.isActive()) {
      this.sink.printAbove(text);
      this.partialOpen = false;
    } else {
      (stream === "stderr" ? this.err : this.out).write(text);
      this.partialOpen = stream === "stdout" ? !text.endsWith("\n") : this.partialOpen;
    }
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
