import { OutputBus } from "../../src/output/bus";
import { OutputChannel } from "../../src/output/channel";

class CaptureStream {
  data = "";
  write(s: string): boolean {
    this.data += s;
    return true;
  }
}

export interface CaptureChannel {
  channel: OutputChannel;
  out: CaptureStream;
  err: CaptureStream;
  /** Everything written to stdout + stderr. */
  all(): string;
}

/**
 * Isolated channel for tests that construct `Repl`: prevents REPL output from
 * touching the real process streams and from attaching a prompt sink to the
 * global default channel (which would leak across test files).
 */
export function makeCaptureChannel(): CaptureChannel {
  const out = new CaptureStream();
  const err = new CaptureStream();
  const channel = new OutputChannel(new OutputBus(), {
    out: out as never,
    err: err as never,
    color: false,
  });
  return { channel, out, err, all: () => out.data + err.data };
}
