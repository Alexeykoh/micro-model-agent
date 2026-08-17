import { describe, it, expect } from "vitest";
import { Readable } from "stream";
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
  completer?: (line: string) => [string[], string];
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
    expect(editor["lines"]).toEqual([""]);
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
    expect(editor["lines"]).toEqual([""]);
  });

  it("completes with a single match", async () => {
    const { input, lines } = makeEditor({
      completer: () => [["/sessions"], "/s"],
    });
    input.pushData("/s");
    input.pushData("\t");
    input.pushData("\r");
    await tick();
    expect(lines).toEqual(["/sessions"]);
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
});
