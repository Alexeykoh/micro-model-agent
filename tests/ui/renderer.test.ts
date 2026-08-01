import { describe, it, expect } from "vitest";
import { Renderer, summarizeArgs } from "../../src/ui/renderer";

function makeOut(): { text: () => string; stream: NodeJS.WritableStream } {
  const parts: string[] = [];
  const stream = {
    write: (s: string) => {
      parts.push(s);
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { text: () => parts.join(""), stream };
}

function makeRenderer(opts: { rich: boolean }): {
  renderer: Renderer;
  text: () => string;
} {
  const out = makeOut();
  const renderer = new Renderer({
    rich: opts.rich,
    spinner: false,
    out: out.stream,
    err: out.stream,
    width: 60,
  });
  return { renderer, text: out.text };
}

describe("summarizeArgs", () => {
  it("prefers known path-like keys", () => {
    expect(summarizeArgs({ path: "src/a.ts", offset: 10 })).toBe("src/a.ts");
  });

  it("falls back to JSON and truncates", () => {
    const long = "x".repeat(100);
    const out = summarizeArgs({ data: long });
    expect(out).toContain("…");
  });

  it("returns empty for empty args", () => {
    expect(summarizeArgs({})).toBe("");
  });
});

describe("Renderer", () => {
  it("renders a boxed card in rich mode", () => {
    const { renderer, text } = makeRenderer({ rich: true });
    renderer.toolStart("write_file", { path: "src/a.ts" });
    renderer.meta("\ncreated src/a.ts\n");
    renderer.toolEnd("write_file", 12, false);
    renderer.flush();
    const out = text();
    expect(out).toContain("┌");
    expect(out).toContain("✓");
    expect(out).toContain("12ms");
    expect(out).toContain("src/a.ts");
  });

  it("marks failed tools with an error marker", () => {
    const { renderer, text } = makeRenderer({ rich: true });
    renderer.toolStart("bash", { command: "false" });
    renderer.toolEnd("bash", 5, true);
    renderer.flush();
    expect(text()).toContain("✗");
  });

  it("uses a plain prefix outside rich mode", () => {
    const { renderer, text } = makeRenderer({ rich: false });
    renderer.toolStart("write_file", { path: "src/a.ts" });
    renderer.meta("created");
    renderer.flush();
    const out = text();
    expect(out).not.toContain("┌");
    expect(out).toContain("⚙");
    expect(out).toContain("created");
  });

  it("formats streamed text as markdown", () => {
    const { renderer, text } = makeRenderer({ rich: false });
    renderer.text("**bold** answer\n");
    renderer.flush();
    const out = text();
    expect(out).toContain("bold");
    expect(out).toContain("answer");
  });

  it("writes errors to the error stream", () => {
    const { renderer, text } = makeRenderer({ rich: false });
    renderer.error("boom");
    expect(text()).toContain("boom");
  });

  it("closes an abandoned card on the next text write", () => {
    const { renderer, text } = makeRenderer({ rich: true });
    renderer.toolStart("bash", { command: "sleep 1" });
    renderer.text("final answer");
    renderer.flush();
    const out = text();
    expect(out).toContain("✗");
    expect(out).toContain("final answer");
  });

  it("starts and stops the thinking spinner", () => {
    const { renderer, text } = makeRenderer({ rich: true });
    renderer.thinkingStart();
    renderer.thinkingEnd();
    renderer.flush();
    expect(text()).toBe("");
  });

  it("thinking spinner is cleared by a tool start", () => {
    const { renderer, text } = makeRenderer({ rich: true });
    renderer.thinkingStart();
    renderer.toolStart("bash", { command: "ls" });
    renderer.toolEnd("bash", 1, false);
    renderer.flush();
    const out = text();
    expect(out).toContain("✓");
    expect(out).toContain("ls");
  });
});
