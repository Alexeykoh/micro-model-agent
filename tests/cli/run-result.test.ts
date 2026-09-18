import { describe, it, expect, beforeEach } from "vitest";
import { printRunResult } from "../../src/cli/run-result";
import { setLocale } from "../../src/i18n/index";
import { OutputBus, OutputChannel } from "../../src/output";

class Capture {
  data = "";
  write(s: string): boolean {
    this.data += s;
    return true;
  }
}

function capture() {
  const bus = new OutputBus();
  const out = new Capture();
  const err = new Capture();
  const channel = new OutputChannel(bus, { out: out as never, err: err as never, color: false });
  return { out, err, channel };
}

describe("printRunResult", () => {
  beforeEach(() => {
    setLocale("en");
  });

  it("returns 1 and prints ONLY the error on failure (not the stale text)", () => {
    const { out, err, channel } = capture();
    const code = printRunResult(
      {
        success: false,
        text: "Task done!",
        error: "Model returned insufficient responses",
      },
      () => {},
      channel,
    );
    expect(code).toBe(1);
    expect(err.data).toContain("Model returned insufficient responses");
    expect(out.data).not.toContain("Task done!");
  });

  it("returns 0 and warns when a successful run produced no text", () => {
    const { out, channel } = capture();
    const code = printRunResult({ success: true, text: "" }, () => {}, channel);
    expect(code).toBe(0);
    expect(out.data).toContain("produced no output");
  });

  it("returns 0 on success without extra output", () => {
    const { out, channel } = capture();
    const code = printRunResult(
      { success: true, text: "stale-text-marker-xyz" },
      () => {},
      channel,
    );
    expect(code).toBe(0);
    expect(out.data).not.toContain("stale-text-marker-xyz");
  });
});
