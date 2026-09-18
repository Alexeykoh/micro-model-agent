import { describe, it, expect, vi } from "vitest";
import { join, sep } from "path";
import { tmpdir } from "os";
import { Renderer, summarizeArgs } from "../../src/ui/renderer";
import { OutputBus } from "../../src/output/bus";
import { OutputChannel, resetDefaultChannel } from "../../src/output";
import { writeWarning } from "../../src/ui/output";

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
  const channel = new OutputChannel(new OutputBus(), {
    out: out.stream,
    err: out.stream,
    color: false,
  });
  const renderer = new Renderer({
    rich: opts.rich,
    spinner: false,
    channel,
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
  it("renders a tool card with icon and footer", () => {
    const { renderer, text } = makeRenderer({ rich: true });
    renderer.toolStart("write_file", { path: "src/a.ts" }, undefined, "📝");
    renderer.meta("\ncreated src/a.ts\n");
    renderer.toolEnd("write_file", 12, false);
    renderer.flush();
    const out = text();
    expect(out).toContain("📝");
    expect(out).toContain("src/a.ts");
    expect(out).toContain("✓");
    expect(out).toContain("12ms");
  });

  it("marks failed tools with an error marker", () => {
    const { renderer, text } = makeRenderer({ rich: true });
    renderer.toolStart("bash", { command: "false" });
    renderer.toolEnd("bash", 5, true);
    renderer.flush();
    expect(text()).toContain("✗");
  });

  it("formats streamed text as markdown", () => {
    const { renderer, text } = makeRenderer({ rich: false });
    renderer.text("**bold** answer\n");
    renderer.flush();
    const out = text();
    expect(out).toContain("bold");
    expect(out).toContain("answer");
  });

  it("renders a chunked markdown answer once, without garbling", () => {
    const { renderer, text } = makeRenderer({ rich: true });
    renderer.text("**bo");
    renderer.text("ld** ans");
    renderer.text("wer\n");
    renderer.flush();
    const out = text();
    expect(out).toContain("bold answer");
    // The formatted line is emitted exactly once (the raw partial is replaced,
    // not duplicated) — the 1.0.0 streaming regression.
    expect(out.split("bold answer").length - 1).toBe(1);
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

  it("renders thought block with timing", () => {
    const { renderer, text } = makeRenderer({ rich: true });
    renderer.thinkingStart();
    renderer.reasoning("analyzing the request...");
    renderer.thinkingEnd();
    renderer.flush();
    const out = text();
    expect(out).toContain("→ Thought:");
    expect(out).toContain("ms");
    expect(out).toContain("analyzing the request...");
  });

  it("does not render empty thought block", () => {
    const { renderer, text } = makeRenderer({ rich: true });
    renderer.thinkingStart();
    renderer.thinkingEnd();
    renderer.flush();
    expect(text()).not.toContain("→ Thought:");
  });

  it("thinking is cleared by a tool start", () => {
    const { renderer, text } = makeRenderer({ rich: true });
    renderer.thinkingStart();
    renderer.toolStart("bash", { command: "ls" });
    renderer.toolEnd("bash", 1, false);
    renderer.flush();
    const out = text();
    expect(out).toContain("✓");
    expect(out).toContain("ls");
  });

  it("shows step context above the tool", () => {
    const { renderer, text } = makeRenderer({ rich: true });
    renderer.toolStart("bash", { command: "bun run build" }, "step 2: run the build");
    renderer.toolEnd("bash", 10, false);
    renderer.flush();
    const out = text();
    expect(out).toContain("↓");
    expect(out).toContain("step 2: run the build");
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

  it("renders footer with model info", () => {
    const { renderer, text } = makeRenderer({ rich: true });
    renderer.footer("qwen3.5-9b", "ollama", 2800);
    renderer.flush();
    const out = text();
    expect(out).toContain("▣");
    expect(out).toContain("qwen3.5-9b");
    expect(out).toContain("ollama");
    expect(out).toContain("2800ms");
  });

  it("flushes a pending markdown partial before a tool header", () => {
    const { renderer, text } = makeRenderer({ rich: false });
    renderer.text("pending partial");
    renderer.toolStart("bash", { command: "ls" });
    renderer.toolEnd("bash", 1, false);
    renderer.flush();
    const out = text();
    expect(out).toContain("pending partial\n");
  });

  it("adds text prefix before first chunk", () => {
    const { renderer, text } = makeRenderer({ rich: true });
    renderer.text("hello world");
    renderer.flush();
    const out = text();
    expect(out).toContain("-");
    expect(out).toContain("hello world");
  });

  describe("relative paths in tool headers", () => {
    function makeBaseRenderer(baseDir?: string, width = 60) {
      const out = makeOut();
      const channel = new OutputChannel(new OutputBus(), {
        out: out.stream,
        err: out.stream,
        color: false,
      });
      const renderer = new Renderer({
        rich: true,
        spinner: false,
        channel,
        width,
        baseDir,
      });
      return { renderer, text: out.text };
    }

    it("shortens absolute paths inside the workspace", () => {
      const base = join(tmpdir(), `mma-renderer-${process.pid}`);
      const abs = join(base, "src", "a.ts");
      const { renderer, text } = makeBaseRenderer(base);
      renderer.toolStart("read_file", { path: abs });
      renderer.flush();
      expect(text()).toContain(`src${sep}a.ts`.split(sep).join("/"));
      expect(text()).not.toContain(`${sep}mma-renderer-${process.pid}${sep}src`);
    });

    it("keeps paths outside the workspace as-is", () => {
      const root = join(tmpdir(), `mma-renderer-out-${process.pid}`);
      const abs = join(root, "elsewhere", "b.ts");
      const { renderer, text } = makeBaseRenderer(join(root, "workspace"));
      renderer.toolStart("read_file", { path: abs });
      renderer.flush();
      expect(text()).toContain(abs.slice(0, 30));
    });

    it("keeps relative paths untouched when no baseDir is set", () => {
      const { renderer, text } = makeRenderer({ rich: true });
      renderer.toolStart("read_file", { path: "src/a.ts" });
      renderer.flush();
      expect(text()).toContain("src/a.ts");
    });
  });

  describe("busy spinners", () => {
    function makeRich(): {
      renderer: Renderer;
      out: () => string;
      err: () => string;
    } {
      const outState = { data: "" };
      const errState = { data: "" };
      const out = {
        write: (s: string) => {
          outState.data += s;
          return true;
        },
      } as unknown as NodeJS.WritableStream;
      const err = {
        write: (s: string) => {
          errState.data += s;
          return true;
        },
      } as unknown as NodeJS.WritableStream;
      const channel = new OutputChannel(new OutputBus(), { out, err, color: false });
      const renderer = new Renderer({
        rich: true,
        spinner: true,
        channel,
        width: 60,
      });
      return { renderer, out: () => outState.data, err: () => errState.data };
    }

    it("spins while thinking", () => {
      const { renderer, err } = makeRich();
      renderer.thinkingStart();
      expect(err().toLowerCase()).toContain("thinking");
      renderer.thinkingEnd();
    });

    it("spins while a tool runs and clears on completion", () => {
      const { renderer, out, err } = makeRich();
      renderer.toolStart("read_file", { path: "src/a.ts" });
      expect(err()).toContain("Reading file");
      expect(out()).toContain("src/a.ts");
      renderer.toolEnd("read_file", 5, false);
      expect(err()).toMatch(/\r\x1b\[K$/);
      expect(out()).toContain("✓");
    });

    it("restarts the spinner on a later thinking phase", () => {
      const { renderer, err } = makeRich();
      renderer.toolStart("bash", { command: "ls" });
      renderer.toolEnd("bash", 1, false);
      renderer.thinkingStart();
      expect(err().toLowerCase()).toContain("thinking");
      renderer.thinkingEnd();
    });

    it("does not spin for interactive tools", () => {
      const { renderer, err } = makeRich();
      renderer.toolStart("question", {});
      expect(err()).not.toContain("Question to user");
      renderer.toolEnd("question", 1, false);
    });
  });
});

describe("deprecated output wrappers", () => {
  it("writeWarning reaches the default channel before any Renderer exists", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      resetDefaultChannel();
      writeWarning("warn-test");
      const written = spy.mock.calls.map((call) => String(call[0])).join("");
      expect(written).toContain("warn-test");
    } finally {
      resetDefaultChannel();
      spy.mockRestore();
    }
  });
});
