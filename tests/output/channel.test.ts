import { describe, it, expect } from "vitest";
import { OutputBus } from "../../src/output/bus";
import {
  OutputChannel,
  getDefaultChannel,
  resetDefaultChannel,
  type PromptSink,
} from "../../src/output/channel";

class S {
  data = "";
  write(s: string): boolean {
    this.data += s;
    return true;
  }
}
function prompt(active = true) {
  const above: string[] = [];
  let on = active;
  const sink: PromptSink = { isActive: () => on, printAbove: (t) => above.push(t) };
  return { sink, above, set: (v: boolean) => (on = v) };
}
function ch() {
  const bus = new OutputBus();
  const out = new S();
  const err = new S();
  const c = new OutputChannel(bus, { out: out as never, err: err as never, color: false });
  return { bus, out, err, c };
}

/** Blocks flushed through a prompt sink are batched one microtask deep. */
const flushMicrotasks = () => Promise.resolve();

describe("OutputChannel", () => {
  it("writes formatted lines to stdout in idle mode", () => {
    const { bus, out } = ch();
    bus.log("info", "indexer", "hello");
    expect(out.data).toContain("[INFO] [indexer]");
  });
  it("prints above the prompt when idle and prompt is active", async () => {
    const { bus, out, c } = ch();
    const p = prompt(true);
    c.attachPrompt(p.sink);
    bus.log("warn", "probe.context", "big");
    await flushMicrotasks();
    expect(p.above).toEqual([expect.stringContaining("big")]);
    expect(out.data).toBe("");
  });
  it("batches a synchronous burst of lines into one printAbove call", async () => {
    const { c } = ch();
    const p = prompt(true);
    c.attachPrompt(p.sink);
    c.writeLine("line 1");
    c.writeLine("line 2");
    c.writeLine("line 3");
    expect(p.above).toEqual([]);
    await flushMicrotasks();
    expect(p.above).toHaveLength(1);
    expect(p.above[0]).toContain("line 1");
    expect(p.above[0]).toContain("line 2");
    expect(p.above[0]).toContain("line 3");
  });
  it("flushes batched blocks before raw output (ordering)", async () => {
    const { c, out } = ch();
    const p = prompt(true);
    c.attachPrompt(p.sink);
    c.writeLine("queued");
    // Raw output must not jump ahead of the queued block.
    c.beginStreaming();
    expect(p.above).toHaveLength(1);
    expect(p.above[0]).toContain("queued");
    c.writeRaw("raw");
    expect(out.data).toContain("raw");
    await flushMicrotasks();
  });
  it("passes streaming raw through and closes the partial before a log", () => {
    const { bus, out, c } = ch();
    c.beginStreaming();
    c.writeRaw("partial");
    expect(out.data.startsWith("partial")).toBe(true);
    bus.log("warn", "s", "note");
    expect(out.data.startsWith("partial\n[WARN] [s]")).toBe(true);
  });
  it("closes streaming with a newline", () => {
    const { c, out } = ch();
    c.beginStreaming();
    c.writeRaw("x", "stdout");
    c.endStreaming();
    expect(out.data.endsWith("x\n")).toBe(true);
  });
  it("queues during modal and flushes on endModal", () => {
    const { bus, out, c } = ch();
    c.beginModal();
    bus.log("info", "s", "later");
    expect(out.data).toBe("");
    c.endModal();
    expect(out.data).toContain("later");
  });
  it("restores the streaming mode after a modal (interactive tool mid-run)", () => {
    const { c } = ch();
    c.beginStreaming();
    c.beginModal();
    c.endModal();
    expect(c.getMode()).toBe("streaming");
  });
  it("closes a streaming partial after a modal, so the next log does not glue", () => {
    const { bus, out, c } = ch();
    c.beginStreaming();
    c.writeRaw("partial");
    c.beginModal();
    c.endModal();
    bus.log("warn", "s", "note");
    expect(out.data.startsWith("partial\n[WARN] [s]")).toBe(true);
  });
  it("drops human output in quiet mode", () => {
    const { bus, out, c } = ch();
    c.setQuiet(true);
    bus.log("error", "s", "boom");
    c.writeLine("banner");
    expect(out.data).toBe("");
  });
  it("writeOverlay is suppressed while prompt is active", () => {
    const { c, err } = ch();
    const p = prompt(true);
    c.attachPrompt(p.sink);
    c.writeOverlay("\rspin");
    expect(err.data).toBe("");
    c.beginStreaming();
    c.writeOverlay("\rspin");
    expect(err.data).toBe("\rspin");
  });
  it("singleton returns the same instance and resets", () => {
    resetDefaultChannel();
    expect(getDefaultChannel()).toBe(getDefaultChannel());
    resetDefaultChannel();
  });
  it("closes a buffered partial line after the prompt deactivates", () => {
    const { bus, out, c } = ch();
    const p = prompt(true);
    c.attachPrompt(p.sink);
    c.writeRaw("abc");
    p.set(false);
    c.beginStreaming();
    bus.log("warn", "s", "note");
    expect(out.data.startsWith("abc\n[WARN] [s]")).toBe(true);
  });
  it("drains pending buffered lines on newlines only", () => {
    const { c } = ch();
    const p = prompt(true);
    c.attachPrompt(p.sink);
    c.writeRaw("a\nb\nc");
    expect(p.above).toEqual(["a\nb"]);
    c.writeRaw("\n");
    expect(p.above).toEqual(["a\nb", "c"]);
  });
  it("endStreaming emits no newline when there is no partial", () => {
    const { c, out } = ch();
    c.beginStreaming();
    c.endStreaming();
    expect(out.data).toBe("");
  });
  it("routes stderr events to the error stream", () => {
    const { bus, out, err } = ch();
    bus.emit({ level: "warn", source: "s", kind: "log", text: "x", stream: "stderr" });
    expect(err.data).toContain("x");
    expect(out.data).toBe("");
  });
  it("restores the prior mode when quiet is lifted", () => {
    const { bus, out, c } = ch();
    c.beginModal();
    bus.log("info", "s", "a");
    c.setQuiet(true);
    c.setQuiet(false);
    expect(c.getMode()).toBe("modal");
    c.endModal();
    expect(out.data).toContain("a");
  });
  it("writes block lines verbatim without formatting", () => {
    const { out, c } = ch();
    c.writeLine("banner");
    expect(out.data).toBe("banner\n");
  });
  it("resets state and detaches from the bus after dispose", () => {
    const { bus, out, c } = ch();
    c.beginStreaming();
    c.dispose();
    expect(c.getMode()).toBe("idle");
    bus.log("info", "s", "x");
    c.writeLine("after");
    expect(out.data).toBe("");
  });
  it("emits ANSI color when forced on", () => {
    const bus = new OutputBus();
    const out = new S();
    const err = new S();
    const c = new OutputChannel(bus, { out: out as never, err: err as never, color: true });
    bus.log("warn", "s", "x");
    expect(out.data).toContain("\x1b[");
    c.dispose();
  });
});
