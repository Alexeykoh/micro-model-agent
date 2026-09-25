import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Readable } from "stream";
import stringWidth from "string-width";
import { LineEditor } from "../../src/ui/line-editor";
import {
  wrapLine,
  buildLayout,
  layoutIndexFor,
  visualColAt,
  charOffsetFor,
  charLen,
  stripAnsi,
} from "../../src/ui/line-math";

class FakeInput extends Readable {
  isTTY = true;
  _read(): void {}
  pushData(data: string | Buffer): void {
    this.push(typeof data === "string" ? Buffer.from(data, "utf8") : data);
  }
}

class FakeOutput {
  data = "";
  columns = 80;
  write(s: string): boolean {
    this.data += s;
    return true;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5));

function makeEditor(opts?: {
  prompt?: string;
  completer?: (
    line: string,
  ) => [Array<{ value: string; description?: string }>, string];
  history?: string[];
}) {
  const input = new FakeInput();
  const output = new FakeOutput();
  const editor = new LineEditor({
    input: input as never,
    output: output as never,
    prompt: opts?.prompt ?? "> ",
    completer: opts?.completer,
    history: opts?.history,
  });
  const lines: string[] = [];
  editor.on("line", (l) => lines.push(l ?? ""));
  return { editor, input, output, lines };
}

describe("line-math", () => {
  describe("wrapLine", () => {
    it("keeps short text as one row", () => {
      expect(wrapLine("abc", 10)).toEqual([{ text: "abc", charStart: 0 }]);
    });

    it("splits on width", () => {
      expect(wrapLine("abcdefghij", 5)).toEqual([
        { text: "abcde", charStart: 0 },
        { text: "fghij", charStart: 5 },
      ]);
    });

    it("treats \\n as a hard break", () => {
      expect(wrapLine("ab\ncd", 80)).toEqual([
        { text: "ab", charStart: 0 },
        { text: "cd", charStart: 3 },
      ]);
    });

    it("keeps trailing newline as an empty row", () => {
      expect(wrapLine("ab\n", 80)).toEqual([
        { text: "ab", charStart: 0 },
        { text: "", charStart: 3 },
      ]);
    });

    it("respects CJK double-width characters", () => {
      const rows = wrapLine("ああa", 4);
      expect(rows.map((r) => r.text)).toEqual(["ああ", "a"]);
    });
  });

  describe("layout navigation", () => {
    const layout = buildLayout(["abcdefghij", "klm"], 5);

    it("builds rows across buffer lines", () => {
      expect(layout).toEqual([
        { bufRow: 0, charStart: 0, text: "abcde" },
        { bufRow: 0, charStart: 5, text: "fghij" },
        { bufRow: 1, charStart: 0, text: "klm" },
      ]);
    });

    it("wraps only the first visual row at firstRowWidth, the rest at width", () => {
      const layout = buildLayout(["abcdefghij", "klm"], 10, 4);
      expect(layout).toEqual([
        { bufRow: 0, charStart: 0, text: "abcd" },
        { bufRow: 0, charStart: 4, text: "efghij" },
        { bufRow: 1, charStart: 0, text: "klm" },
      ]);
    });

    it("maps a cursor position to a visual row", () => {
      expect(layoutIndexFor(layout, 0, 6)).toBe(1);
      expect(layoutIndexFor(layout, 1, 1)).toBe(2);
    });

    it("computes the visual column within a row", () => {
      expect(visualColAt(layout, 1, 6)).toBe(1);
      expect(visualColAt(layout, 0, 3)).toBe(3);
    });

    it("maps a visual column back to a char offset", () => {
      expect(charOffsetFor(layout, 1, 1)).toBe(6);
      expect(charOffsetFor(layout, 1, 4)).toBe(9);
      expect(charOffsetFor(layout, 2, 5)).toBe(3);
    });
  });

  describe("stripAnsi", () => {
    it("removes ANSI color codes", () => {
      expect(stripAnsi("\x1b[36m> \x1b[0m")).toBe("> ");
    });
  });

  describe("charLen", () => {
    it("counts codepoints, not UTF-16 units", () => {
      expect(charLen("a😀b")).toBe(3);
    });
  });
});

describe("LineEditor", () => {
  beforeEach(() => {
    process.env.MMA_DSR = "0";
  });
  afterEach(() => {
    delete process.env.MMA_DSR;
  });

  it("emits a line on Enter", async () => {
    const { input, lines } = makeEditor();
    input.pushData("hello");
    input.pushData("\r");
    await tick();
    expect(lines).toEqual(["hello"]);
  });

  it("does not double-submit on CRLF", async () => {
    const { input, lines } = makeEditor();
    input.pushData("x\r\n");
    await tick();
    expect(lines).toEqual(["x"]);
  });

  it("handles backspace", async () => {
    const { editor, input, lines } = makeEditor();
    input.pushData("ab");
    input.pushData("\x7f");
    input.pushData("\r");
    await tick();
    expect(lines).toEqual(["a"]);
    expect(editor.lines).toEqual([""]);
  });

  it("supports left/right cursor navigation", async () => {
    const { input, lines } = makeEditor();
    input.pushData("abc");
    input.pushData("\x1b[D"); // left
    input.pushData("X");
    input.pushData("\r");
    await tick();
    expect(lines).toEqual(["abXc"]);
  });

  it("inserts a newline on kitty Shift+Enter", async () => {
    const { input, lines } = makeEditor();
    input.pushData("a");
    input.pushData("\x1b[13;2u");
    input.pushData("b");
    input.pushData("\r");
    await tick();
    expect(lines).toEqual(["a\nb"]);
  });

  it("inserts a newline on ESC+CR fallback", async () => {
    const { input, lines } = makeEditor();
    input.pushData("a");
    input.pushData("\x1b\r");
    input.pushData("b");
    input.pushData("\r");
    await tick();
    expect(lines).toEqual(["a\nb"]);
  });

  it("inserts a newline on bare LF (Ctrl+J)", async () => {
    const { input, lines } = makeEditor();
    input.pushData("a");
    input.pushData("\u000a");
    input.pushData("b");
    input.pushData("\r");
    await tick();
    expect(lines).toEqual(["a\nb"]);
  });

  it("joins lines with backspace at the start", async () => {
    const { input, lines } = makeEditor();
    input.pushData("a");
    input.pushData("\x1b[13;2u"); // newline, cursor at start of line 2
    input.pushData("\x7f"); // backspace at col 0 joins the lines
    input.pushData("b");
    input.pushData("\r");
    await tick();
    expect(lines).toEqual(["ab"]);
  });

  it("pastes multi-line text via bracketed paste", async () => {
    const { input, lines } = makeEditor();
    input.pushData("\x1b[200~");
    input.pushData("line1\nline2");
    input.pushData("\x1b[201~");
    input.pushData("\r");
    await tick();
    expect(lines).toEqual(["line1\nline2"]);
  });

  it("collapses CRLF line endings when pasting (Windows clipboard)", async () => {
    const { input, lines } = makeEditor();
    input.pushData("\x1b[200~");
    input.pushData("line1\r\nline2\r\nline3");
    input.pushData("\x1b[201~");
    input.pushData("\r");
    await tick();
    expect(lines).toEqual(["line1\nline2\nline3"]);
  });

  it("turns a lone trailing CR into a single trailing newline, not doubled", async () => {
    const { input, lines } = makeEditor();
    input.pushData("\x1b[200~");
    input.pushData("line1\r");
    input.pushData("\x1b[201~");
    input.pushData("\r");
    await tick();
    expect(lines).toEqual(["line1\n"]);
  });

  it("renders the whole paste once instead of per character", async () => {
    const { input, output } = makeEditor();
    input.pushData("\x1b[200~");
    input.pushData("hello\nworld");
    input.pushData("\x1b[201~");
    await tick();
    // One render for the pasted block: one clear-line per layout row (2 rows).
    const clears = (output.data.match(/\x1b\[2K/g) || []).length;
    expect(clears).toBe(2);
  });

  it("navigates history with up/down", async () => {
    const { editor, input, lines } = makeEditor({ history: ["prev"] });
    input.pushData("\x1b[A"); // up
    input.pushData("\r");
    await tick();
    expect(lines).toEqual(["prev"]);
    expect(editor.lines).toEqual([""]);
  });

  it("completes with a single match", async () => {
    const { input, lines } = makeEditor({
      completer: () => [[{ value: "/sessions" }], "/s"],
    });
    input.pushData("/s");
    input.pushData("\t");
    input.pushData("\r");
    await tick();
    expect(lines).toEqual(["/sessions"]);
  });

  it("renders descriptions in the multi-match list", async () => {
    const { editor, input, output } = makeEditor({
      completer: () => [
        [
          { value: "/help", description: "Show help" },
          { value: "/health", description: "Check health" },
        ],
        "/h",
      ],
    });
    input.pushData("/h");
    input.pushData("\t");
    await tick();
    expect(output.data).toContain("/help  Show help");
    expect(output.data).toContain("/health  Check health");
    editor.close();
  });

  it("clamps multi-match rows to the terminal width (no wrapping)", async () => {
    const { editor, input, output } = makeEditor({
      completer: () => [
        [
          { value: "/verylongcommand", description: "x".repeat(200) },
          { value: "/other", description: "y".repeat(200) },
        ],
        "/",
      ],
    });
    input.pushData("/");
    input.pushData("\t");
    await tick();
    const rows = output.data
      .split("\r\n")
      .filter((l) => l.includes("…"));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(stringWidth(stripAnsi(row))).toBeLessThan(80);
    }
    // Every emitted row — ellipsis or not — must stay strictly narrower than
    // the terminal so an off-by-one clamp cannot wrap.
    const listRows = output.data
      .split("\r\n")
      .filter((l) => l.includes("/"));
    for (const row of listRows) {
      expect(stringWidth(stripAnsi(row))).toBeLessThan(80);
    }
    editor.close();
  });

  it("answers questions through question()", async () => {
    const { editor, input } = makeEditor();
    let answer = "";
    editor.question("Name: ", (a) => {
      answer = a;
    });
    input.pushData("alex");
    input.pushData("\r");
    await tick();
    expect(answer).toBe("alex");
  });

  it("emits close on close()", () => {
    const { editor } = makeEditor();
    let closed = false;
    editor.on("close", () => {
      closed = true;
    });
    editor.close();
    expect(closed).toBe(true);
  });

  it("wraps the first line at width minus prompt (no frame desync)", async () => {
    const { editor, input } = makeEditor({ prompt: "You: " });
    input.pushData("x".repeat(200));
    await tick();
    const layout = editor.layout();
    // First visual row + the 5-char prompt must fit into 80 columns,
    // otherwise the terminal auto-wraps and every following row shifts.
    expect(layout[0].text.length).toBeLessThanOrEqual(80 - 5);
  });

  it("keeps every rendered visual row within the terminal width", async () => {
    const { editor, input, output } = makeEditor({ prompt: "You: " });
    input.pushData("y".repeat(150));
    input.pushData("\x1b[13;2u"); // Shift+Enter → second buffer line
    input.pushData("z".repeat(90));
    await tick();
    const layout = editor.layout();
    for (const row of layout) {
      expect(row.text.length).toBeLessThanOrEqual(80);
    }
    // The last render must redraw exactly layout.length rows — one clear
    // per row, no stale duplicates from a misaligned frame.
    const lastRenderStart = output.data.lastIndexOf("\x1b[");
    const clears = (output.data.match(/\x1b\[2K/g) || []).length;
    expect(clears).toBeGreaterThanOrEqual(layout.length);
  });

  it("sends one DSR query per frame when enabled and parses the reply", async () => {
    process.env.MMA_DSR = "1";
    const { editor, input, output } = makeEditor({ prompt: "You: " });
    editor.prompt();
    expect(output.data).toContain("\x1b[6n");
    output.data = "";
    input.pushData("\x1b[4;1R"); // cursor-position report: row 4
    await tick();
    input.pushData("!");
    await tick();
    expect(output.data.startsWith("\x1b[4;1H")).toBe(true);
  });

  it("disables the DSR query by default on Windows, enables it elsewhere", () => {
    delete process.env.MMA_DSR;
    const { editor, output } = makeEditor({ prompt: "You: " });
    editor.prompt();
    if (process.platform === "win32") {
      expect(output.data).not.toContain("\x1b[6n");
    } else {
      expect(output.data).toContain("\x1b[6n");
    }
  });

  it("does not treat a DSR cursor report as typed input", async () => {
    process.env.MMA_DSR = "1";
    const { editor, input, output } = makeEditor({ prompt: "You: " });
    editor.prompt();
    output.data = "";
    input.pushData("\x1b[4;1R"); // cursor-position report
    await tick();
    input.pushData("x");
    await tick();
    expect(editor.lines[0]).toBe("x");
    expect(editor.lines[0]).not.toContain("R");
  });

  it("does not query DSR while a question is pending", async () => {
    process.env.MMA_DSR = "1";
    const { editor, output } = makeEditor({ prompt: "You: " });
    editor.question("Q: ", () => {});
    expect(output.data).not.toContain("\x1b[6n");
  });

  it("anchors the DSR reply against the query-time row, not a later render", async () => {
    process.env.MMA_DSR = "1";
    const { editor, input, output } = makeEditor({ prompt: "You: " });
    editor.prompt(); // query sent with dsrQueryRow = 0
    input.pushData("a");
    input.pushData("\x1b[13;2u"); // newline → cursor visual row 1
    await tick();
    expect(editor.dsrPending).toBe(true);
    expect(editor.dsrQueryRow).toBe(0);
    expect(editor.prevCursorRow).toBe(1);
    output.data = "";
    input.pushData("\x1b[9;1R"); // reply: cursor on screen row 9
    await tick();
    // top = 9 - dsrQueryRow(0) = 9, not 9 - prevCursorRow(1) = 8.
    input.pushData("b");
    await tick();
    expect(editor.frameTopAbs).toBe(9);
    expect(output.data.startsWith("\x1b[9;1H")).toBe(true);
  });

  it("learns the absolute frame anchor from a DSR reply", async () => {
    const { editor, input, output } = makeEditor({ prompt: "You: " });
    // DSR disabled by default; manually set anchor to simulate a reply.
    input.pushData("hello");
    await tick();
    expect(output.data).not.toContain("\x1b[1;1H");
    // Manually set the anchor (simulating a DSR reply).
    editor.frameTopAbs = 4;
    // Next keystroke renders with an ABSOLUTE home onto row 4.
    output.data = "";
    input.pushData("!");
    await tick();
    expect(output.data.startsWith("\x1b[4;1H")).toBe(true);
  });

  it("updates the anchor deterministically after a scroll", async () => {
    const { editor, input, output } = makeEditor();
    (output as unknown as { rows: number }).rows = 12;
    // Manually set anchor to simulate DSR reply.
    editor.frameTopAbs = 8;
    // Build a 3-row buffer.
    input.pushData("a\x1b[13;2ub\x1b[13;2uc");
    await tick();
    // T=8, L=3, H=12 → no scroll (8+2=10 ≤ 12).
    output.data = "";
    input.pushData("d");
    await tick();
    expect(output.data.startsWith("\x1b[8;1H")).toBe(true);
    expect(editor.frameTopAbs).toBe(8);
    // Add lines so T+L-1 > H → scroll occurs.
    input.pushData("\x1b[13;2u");
    input.pushData("e");
    await tick();
    // T=8, L=4, H=12 → 8+3=11 ≤ 12, still no scroll.
    input.pushData("\x1b[13;2u");
    input.pushData("f");
    await tick();
    // T=8, L=5, H=12 → 8+4=12 ≤ 12, still no scroll.
    input.pushData("\x1b[13;2u");
    input.pushData("g");
    await tick();
    // T=8, L=6, H=12 → 8+5=13 > 12 → scroll by 1. New anchor = 12-6+1 = 7.
    expect(editor.frameTopAbs).toBe(7);
  });

  it("caps the rendered frame to the visible screen rows", async () => {
    const { editor, input, output } = makeEditor();
    (output as unknown as { rows: number }).rows = 5;
    input.pushData("\x1b[200~");
    input.pushData("l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10");
    input.pushData("\x1b[201~");
    await tick();
    // maxRows = rows - 2 = 3: only the tail of the frame is drawn.
    const clears = (output.data.match(/\x1b\[2K/g) || []).length;
    expect(clears).toBe(3);
    expect(editor.visibleLayout().length).toBe(3);
  });

  it("resets the anchor on reset() and question()", async () => {
    const { editor, input } = makeEditor();
    editor.frameTopAbs = 5;
    input.pushData("abc");
    await tick();
    expect(editor.frameTopAbs).toBe(5);
    editor.reset();
    expect(editor.frameTopAbs).toBeNull();
    editor.question("Name: ", () => {});
    expect(editor.frameTopAbs).toBeNull();
  });
});
