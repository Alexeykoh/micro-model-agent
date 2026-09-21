import { describe, it, expect } from "vitest";
import { Writable } from "stream";
import { Renderer, toolMarker } from "../src/ui/renderer";
import { OutputBus } from "../src/output/bus";
import { OutputChannel } from "../src/output/channel";

class Capture extends Writable {
  chunks: string[] = [];
  _write(chunk: Buffer | string, _enc: string, cb: () => void): void {
    this.chunks.push(String(chunk));
    cb();
  }
  get text(): string {
    return this.chunks.join("");
  }
}

function makeRenderer(): {
  renderer: Renderer;
  capture: Capture;
} {
  const capture = new Capture();
  const channel = new OutputChannel(new OutputBus(), {
    out: capture,
    err: capture,
    color: false,
  });
  const renderer = new Renderer({
    rich: true,
    channel,
    width: 60,
  });
  return { renderer, capture };
}

describe("toolMarker", () => {
  it("uses the shared action glyph for every tool", () => {
    expect(toolMarker("write_file")).toBe("◇");
    expect(toolMarker("read_file")).toBe("◇");
    expect(toolMarker("glob")).toBe("◇");
    expect(toolMarker("bash")).toBe("◇");
    expect(toolMarker("web_search")).toBe("◇");
  });
});

describe("Renderer", () => {
  it("toolStart prints a header with the action glyph", () => {
    const { renderer, capture } = makeRenderer();
    renderer.toolStart("edit_file", { path: "src/foo.ts" });
    const out = capture.text;
    expect(out).toContain("◇");
    expect(out).toContain("src/foo.ts");
  });

  it("meta streams body lines with a gutter", () => {
    const { renderer, capture } = makeRenderer();
    renderer.toolStart("edit_file", { path: "src/foo.ts" });
    renderer.meta("line one\n\nline two");
    const out = capture.text;
    expect(out).toContain("  line one");
    expect(out).toContain("  line two");
    expect(out).not.toContain("\n  \n");
  });

  it("toolEnd prints footer without divider", () => {
    const { renderer, capture } = makeRenderer();
    renderer.toolStart("bash", { command: "bun test" });
    renderer.meta("some output");
    renderer.toolEnd("bash", 370);
    const out = capture.text;
    expect(out).toContain("370ms");
    expect(out).not.toContain("─");
  });

  it("text() closes the card before streaming", () => {
    const { renderer, capture } = makeRenderer();
    renderer.toolStart("read_file", { path: "src/foo.ts" });
    renderer.meta("file content");
    renderer.text("final answer");
    renderer.flush();
    const out = capture.text;
    expect(out).toContain("final answer");
  });
});

describe("Renderer plain mode", () => {
  it("does not emit box characters", () => {
    const capture = new Capture();
    const channel = new OutputChannel(new OutputBus(), {
      out: capture,
      err: capture,
      color: false,
    });
    const renderer = new Renderer({
      rich: false,
      channel,
      width: 60,
    });
    renderer.toolStart("bash", { command: "bun test" });
    renderer.meta("output");
    renderer.toolEnd("bash", 5);
    expect(capture.text).not.toContain("┌");
  });
});
