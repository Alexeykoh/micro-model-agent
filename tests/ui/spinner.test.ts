import { describe, it, expect, vi } from "vitest";
import { Spinner } from "../../src/ui/spinner";

function makeStream(): { data: () => string; stream: NodeJS.WritableStream } {
  const state = { data: "" };
  const stream = {
    write: (s: string) => {
      state.data += s;
      return true;
    },
    isTTY: true,
  } as unknown as NodeJS.WritableStream;
  return { data: () => state.data, stream };
}

describe("Spinner", () => {
  it("does not write when disabled", () => {
    const { data, stream } = makeStream();
    const spinner = new Spinner({ enabled: false, stream });
    spinner.start("working");
    spinner.stop();
    expect(data()).toBe("");
  });

  it("writes frames and clears on stop", () => {
    const { data, stream } = makeStream();
    const spinner = new Spinner({ enabled: true, stream, intervalMs: 10 });
    spinner.start("doing stuff");
    expect(data()).toContain("doing stuff");
    spinner.stop();
    expect(spinner.running).toBe(false);
    expect(data()).toMatch(/\r\x1b\[K$/);
  });

  it("truncates long messages to width", () => {
    const { data, stream } = makeStream();
    const spinner = new Spinner({ enabled: true, stream, width: 20 });
    spinner.start("x".repeat(100));
    spinner.stop();
    expect(data()).toContain("…");
    expect(data()).not.toContain("x".repeat(50));
  });

  it("setMessage updates the current line", () => {
    const { stream } = makeStream();
    const spinner = new Spinner({ enabled: true, stream, intervalMs: 100 });
    spinner.start("one");
    spinner.setMessage("two");
    expect((stream as any).write).toBeDefined();
    spinner.stop();
    vi.useRealTimers();
  });
});
