import { describe, it, expect, vi } from "vitest";
import { Spinner } from "../../src/ui/spinner";
import { OutputBus } from "../../src/output/bus";
import { OutputChannel } from "../../src/output/channel";

function makeChannel(): { data: () => string; channel: OutputChannel } {
  const state = { data: "" };
  const err = {
    write: (s: string) => {
      state.data += s;
      return true;
    },
    isTTY: true,
  } as unknown as NodeJS.WritableStream;
  const channel = new OutputChannel(new OutputBus(), { err, color: false });
  return { data: () => state.data, channel };
}

describe("Spinner", () => {
  it("does not write when disabled", () => {
    const { data, channel } = makeChannel();
    const spinner = new Spinner({ enabled: false, channel });
    spinner.start("working");
    spinner.stop();
    expect(data()).toBe("");
  });

  it("writes frames and clears on stop", () => {
    const { data, channel } = makeChannel();
    const spinner = new Spinner({ enabled: true, channel, intervalMs: 10 });
    spinner.start("doing stuff");
    expect(data()).toContain("doing stuff");
    spinner.stop();
    expect(spinner.running).toBe(false);
    expect(data()).toMatch(/\r\x1b\[K$/);
  });

  it("truncates long messages to width", () => {
    const { data, channel } = makeChannel();
    const spinner = new Spinner({ enabled: true, channel, width: 20 });
    spinner.start("x".repeat(100));
    spinner.stop();
    expect(data()).toContain("…");
    expect(data()).not.toContain("x".repeat(50));
  });

  it("setMessage updates the current line", () => {
    const { data, channel } = makeChannel();
    const spinner = new Spinner({ enabled: true, channel, intervalMs: 100 });
    spinner.start("one");
    spinner.setMessage("two");
    expect(data()).toContain("two");
    spinner.stop();
    vi.useRealTimers();
  });
});
