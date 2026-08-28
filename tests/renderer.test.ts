import { describe, it, expect } from "vitest";
import { Writable } from "stream";
import { Renderer, toolMarker } from "../src/ui/renderer";

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
  const renderer = new Renderer({
    rich: true,
    out: capture,
    err: capture,
    width: 60,
  });
  return { renderer, capture };
}

describe("toolMarker", () => {
  it("maps write/edit tools to the edit arrow", () => {
    expect(toolMarker("write_file")).toBe("←");
    expect(toolMarker("edit_file")).toBe("←");
    expect(toolMarker("create_dir")).toBe("←");
  });

  it("maps read tools to the read arrow", () => {
    expect(toolMarker("read_file")).toBe("→");
    expect(toolMarker("list_dir")).toBe("→");
  });

  it("maps search tools to the asterisk", () => {
    expect(toolMarker("glob")).toBe("✱");
    expect(toolMarker("grep")).toBe("✱");
  });

  it("maps bash to the dollar sign", () => {
    expect(toolMarker("bash")).toBe("$");
  });

  it("defaults to gear for unknown tools", () => {
    expect(toolMarker("web_search")).toBe("⚙");
  });
});

describe("Renderer", () => {
  it("toolStart prints a header with icon", () => {
    const { renderer, capture } = makeRenderer();
    renderer.toolStart("edit_file", { path: "src/foo.ts" });
    const out = capture.text;
    expect(out).toContain("←");
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
    const renderer = new Renderer({
      rich: false,
      out: capture,
      err: capture,
      width: 60,
    });
    renderer.toolStart("bash", { command: "bun test" });
    renderer.meta("output");
    renderer.toolEnd("bash", 5);
    expect(capture.text).not.toContain("┌");
  });
});
