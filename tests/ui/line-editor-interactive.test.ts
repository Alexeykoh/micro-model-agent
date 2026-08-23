import { describe, it, expect } from "vitest";
import { Readable } from "stream";
import { LineEditor } from "../../src/ui/line-editor";

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
  columns?: number;
  onInterrupt?: () => void;
}) {
  const input = new FakeInput();
  const output = new FakeOutput();
  if (opts?.columns) output.columns = opts.columns;
  const editor = new LineEditor({
    input: input as never,
    output: output as never,
    prompt: "> ",
    onInterrupt: opts?.onInterrupt,
  });
  const lines: string[] = [];
  editor.on("line", (l) => lines.push(l ?? ""));
  return { editor, input, output, lines };
}

describe("LineEditor interactive", () => {
  it("renders the prompt with cursor after it", () => {
    const { editor, output } = makeEditor();
    editor.prompt();
    expect(output.data.endsWith("\r\x1b[2K> \x1b[J\r\x1b[2C")).toBe(true);
  });

  it("redraws on typing", async () => {
    const { editor, input, output } = makeEditor();
    editor.prompt();
    input.pushData("hi");
    await tick();
    // prompt() sent the DSR query; typing render uses relative moves, no query.
    expect(output.data.endsWith("\r\x1b[2K> hi\x1b[J\r\x1b[4C")).toBe(true);
  });

  it("wraps long input into multiple rows (first row fits with the prompt)", async () => {
    const { editor, input, output } = makeEditor({ columns: 5 });
    editor.prompt();
    input.pushData("abcdef");
    await tick();
    // Prompt (2) + first visual row must fit into 5 columns → "> abc",
    // the continuation row gets the full width → "def".
    expect(output.data).toContain("> abc\r\n");
    expect(output.data).toContain("\x1b[2Kdef");
  });

  it("redraws from the frame top when typing on a lower row (no duplicates)", async () => {
    const { editor, input, output } = makeEditor();
    editor.prompt();
    input.pushData("1");
    input.pushData("\x1b[13;2u"); // newline
    input.pushData("2");
    await tick();
    // prompt() sent DSR query; typing renders use relative moves, no query.
    expect(output.data.endsWith("\x1b[1A\r\x1b[2K> 1\r\n\x1b[2K2\x1b[J\r\x1b[1C")).toBe(true);
  });

  it("commits the submitted buffer without erasing it", async () => {
    const { editor, input, output } = makeEditor();
    editor.prompt();
    input.pushData("a");
    input.pushData("\x1b[13;2u");
    input.pushData("b");
    input.pushData("\r"); // submit "a\nb"
    await tick();
    // After submit the frame is committed: the cursor moves to the next line
    // and the editor must NOT redraw an empty buffer over the submitted text.
    expect(output.data.endsWith("\x1b[1C\r\n")).toBe(true);
  });

  it("host hook can swallow keys", async () => {
    const { editor, input, lines } = makeEditor();
    editor.onKeyInput = () => true;
    input.pushData("no");
    input.pushData("\r");
    await tick();
    expect(lines).toEqual([]);
  });

  it("invokes the onInterrupt hook on Ctrl+C (never a process signal)", async () => {
    let interrupted = false;
    const { input } = makeEditor({
      onInterrupt: () => {
        interrupted = true;
      },
    });
    input.pushData("\u0003");
    await tick();
    expect(interrupted).toBe(true);
  });

  it("re-presents a clean prompt after reset()", async () => {
    const { editor, input, output } = makeEditor();
    editor.prompt();
    input.pushData("dirty");
    await tick();
    output.data = "";
    editor.reset();
    expect(output.data.endsWith("\r\x1b[2K> \x1b[J\r\x1b[2C")).toBe(true);
  });

  it("emits close on Ctrl+D at an empty prompt", async () => {
    const { editor, input } = makeEditor();
    let closed = false;
    editor.on("close", () => {
      closed = true;
    });
    input.pushData("\u0004");
    await tick();
    expect(closed).toBe(true);
  });

  it("setPrompt changes the rendered prompt", () => {
    const { editor, output } = makeEditor();
    editor.setPrompt("... ");
    editor.prompt();
    expect(output.data).toContain("... ");
  });
});
