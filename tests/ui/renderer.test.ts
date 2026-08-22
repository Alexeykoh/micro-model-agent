import { describe, it, expect } from "vitest";
import { join, sep } from "path";
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

function makeRenderer(opts: { rich: boolean; toolStyle?: "box" | "inline" }): {
  renderer: Renderer;
  text: () => string;
} {
  const out = makeOut();
  const renderer = new Renderer({
    rich: opts.rich,
    spinner: false,
    toolStyle: opts.toolStyle ?? "inline",
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
  it("renders a boxed card in rich mode with box toolStyle", () => {
    const { renderer, text } = makeRenderer({ rich: true, toolStyle: "box" });
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

  it("renders an inline header in rich mode by default (no box)", () => {
    const { renderer, text } = makeRenderer({ rich: true });
    renderer.toolStart("edit_file", { path: "src/a.ts" });
    renderer.meta("\nupdated\n");
    renderer.toolEnd("edit_file", 12, false);
    renderer.flush();
    const out = text();
    expect(out).toContain("←");
    expect(out).toContain("src/a.ts");
    expect(out).toContain("12ms");
    expect(out).not.toContain("┌");
    expect(out).not.toContain("┐");
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
    expect(out).toContain("←");
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
    expect(out).toContain("✓");
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

  it("appends a step context suffix to the inline header", () => {
    const { renderer, text } = makeRenderer({ rich: true });
    renderer.toolStart("bash", { command: "bun run build" }, "step 2: run the build");
    renderer.toolEnd("bash", 10, false);
    renderer.flush();
    const out = text();
    expect(out).toContain("← step 2: run the build");
  });

  it("starts a busy spinner for lsp_check in inline mode", () => {
    const out = makeOut();
    const renderer = new Renderer({
      rich: true,
      spinner: true,
      toolStyle: "inline",
      out: out.stream,
      err: out.stream,
      width: 60,
    });
    renderer.toolStart("lsp_check", { path: "src" });
    renderer.toolEnd("lsp_check", 10, false);
    renderer.flush();
    const textOut = out.text();
    expect(textOut).toContain("⠋");
    expect(textOut).toContain("Checking code");
  });

  it("does not start a busy spinner for other tools", () => {
    const out = makeOut();
    const renderer = new Renderer({
      rich: true,
      spinner: true,
      toolStyle: "inline",
      out: out.stream,
      err: out.stream,
      width: 60,
    });
    renderer.toolStart("bash", { command: "ls" });
    renderer.toolEnd("bash", 1, false);
    renderer.flush();
    expect(out.text()).not.toContain("⠋");
  });

  it("shows the session cost in the tool footer when pricing is known", () => {
    const { renderer, text } = makeRenderer({ rich: true });
    renderer.toolStart("write_file", { path: "src/a.ts" });
    renderer.toolEnd("write_file", 10, false, 5, 0.0012);
    renderer.flush();
    const out = text();
    expect(out).toContain("✓");
    expect(out).toContain("cost");
    expect(out).toContain("$0.0012");
  });

  it("omits the cost when the value is zero or unknown", () => {
    const { renderer, text } = makeRenderer({ rich: true });
    renderer.toolStart("write_file", { path: "src/a.ts" });
    renderer.toolEnd("write_file", 10, false, 5, 0);
    renderer.flush();
    expect(text()).not.toContain("cost");
  });

  it("shows the cost in plain (non-rich) mode", () => {
    const { renderer, text } = makeRenderer({ rich: false });
    renderer.toolStart("write_file", { path: "src/a.ts" });
    renderer.toolEnd("write_file", 10, false, 5, 0.02);
    renderer.flush();
    const out = text();
    expect(out).toContain("cost");
    expect(out).toContain("$0.02");
  });

  it("appends a step context suffix in plain mode", () => {
    const { renderer, text } = makeRenderer({ rich: false });
    renderer.toolStart("bash", { command: "bun run build" }, "step 2: run the build");
    renderer.flush();
    expect(text()).toContain("step 2: run the build");
  });

  it("renders a plan checklist block verbatim", () => {
    const { renderer, text } = makeRenderer({ rich: true });
    renderer.planBlock(["[plan_x] Check", "  [x] 1. done", "  [ ] 2. todo"]);
    renderer.flush();
    const out = text();
    expect(out).toContain("[plan_x] Check");
    expect(out).toContain("[ ] 2. todo");
  });

  it("closes an open card before rendering the plan block", () => {
    const { renderer, text } = makeRenderer({ rich: true });
    renderer.toolStart("bash", { command: "bun run build" });
    renderer.planBlock(["[plan_x] Check"]);
    renderer.flush();
    const out = text();
    expect(out).toContain("✓");
    expect(out).toContain("[plan_x] Check");
  });

  describe("relative paths in tool headers", () => {
    function makeBaseRenderer(baseDir?: string) {
      const out = makeOut();
      const renderer = new Renderer({
        rich: true,
        spinner: false,
        toolStyle: "inline",
        out: out.stream,
        err: out.stream,
        width: 60,
        baseDir,
      });
      return { renderer, text: out.text };
    }

    it("shortens absolute paths inside the workspace", () => {
      const abs = join("E:", sep, "proj", "src", "a.ts");
      const { renderer, text } = makeBaseRenderer(join("E:", sep, "proj"));
      renderer.toolStart("read_file", { path: abs });
      renderer.flush();
      expect(text()).toContain("src/a.ts");
      expect(text()).not.toContain(`${sep}proj${sep}src`);
    });

    it("keeps paths outside the workspace as-is", () => {
      const abs = join("E:", sep, "other", "b.ts");
      const { renderer, text } = makeBaseRenderer(join("E:", sep, "proj"));
      renderer.toolStart("read_file", { path: abs });
      renderer.flush();
      expect(text()).toContain(abs);
    });

    it("keeps relative paths untouched when no baseDir is set", () => {
      const { renderer, text } = makeRenderer({ rich: true });
      renderer.toolStart("read_file", { path: "src/a.ts" });
      renderer.flush();
      expect(text()).toContain("src/a.ts");
    });
  });
});
