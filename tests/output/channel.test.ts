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

describe("OutputChannel", () => {
  it("writes formatted lines to stdout in idle mode", () => {
    const { bus, out } = ch();
    bus.log("info", "indexer", "hello");
    expect(out.data).toContain("[INFO] [indexer]");
  });
  it("prints above the prompt when idle and prompt is active", () => {
    const { bus, out, c } = ch();
    const p = prompt(true);
    c.attachPrompt(p.sink);
    bus.log("warn", "probe.context", "big");
    expect(p.above).toEqual([expect.stringContaining("big")]);
    expect(out.data).toBe("");
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
});
