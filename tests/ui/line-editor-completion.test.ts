import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
// A lone ESC is only emitted after readline's escape-code timeout (~500ms),
// since it cannot know whether more sequence bytes follow.
const escapeTick = () => new Promise((r) => setTimeout(r, 550));

const threeMatches = () => [
  [{ value: "/alpha" }, { value: "/beta" }, { value: "/gamma" }],
  "/",
] as [{ value: string }[], string];

function makeEditor(opts?: {
  prompt?: string;
  completer?: (line: string) => [{ value: string; description?: string }[], string];
}) {
  const input = new FakeInput();
  const output = new FakeOutput();
  const editor = new LineEditor({
    input: input as never,
    output: output as never,
    prompt: opts?.prompt ?? "> ",
    completer: opts?.completer,
  });
  const lines: string[] = [];
  editor.on("line", (l) => lines.push(l ?? ""));
  return { editor, input, output, lines };
}

describe("LineEditor tab completion cycling", () => {
  beforeEach(() => {
    process.env.MMA_DSR = "0";
  });
  afterEach(() => {
    delete process.env.MMA_DSR;
  });

  it("inserts the first match on Tab and cycles down/up", async () => {
    const { editor, input } = makeEditor({ completer: threeMatches });
    input.pushData("/");
    input.pushData("\t");
    await tick();
    expect(editor["lines"][0]).toBe("/alpha");
    expect(editor["completionSession"]).not.toBeNull();

    input.pushData("\x1b[B"); // down
    await tick();
    expect(editor["lines"][0]).toBe("/beta");

    input.pushData("\x1b[A"); // up
    await tick();
    expect(editor["lines"][0]).toBe("/alpha");

    editor.close();
  });

  it("cycles forward with Tab while a session is active", async () => {
    const { editor, input } = makeEditor({ completer: threeMatches });
    input.pushData("/");
    input.pushData("\t");
    await tick();
    input.pushData("\t"); // second Tab cycles, does not re-print/complete
    await tick();
    expect(editor["lines"][0]).toBe("/beta");
    editor.close();
  });

  it("restores the original partial on Escape", async () => {
    const { editor, input } = makeEditor({ completer: threeMatches });
    input.pushData("/");
    input.pushData("\t");
    await tick();
    expect(editor["lines"][0]).toBe("/alpha");

    input.pushData("\x1b"); // escape
    await escapeTick();
    expect(editor["lines"][0]).toBe("/");
    expect(editor["completionSession"]).toBeNull();
    editor.close();
  });

  it("restores the original partial on Escape even when the host hook consumes Esc", async () => {
    const { editor, input } = makeEditor({ completer: threeMatches });
    const captured: string[] = [];
    editor.onKeyInput = (_str, key) => {
      if ((key as { name?: string })?.name === "escape") {
        captured.push("escape");
        return true;
      }
      return false;
    };
    input.pushData("/");
    input.pushData("\t");
    await tick();
    expect(editor["lines"][0]).toBe("/alpha");

    input.pushData("\x1b"); // escape
    await escapeTick();
    expect(editor["lines"][0]).toBe("/");
    expect(editor["completionSession"]).toBeNull();
    expect(captured).toEqual([]);
    editor.close();
  });

  it("clears the session and inserts a printable key", async () => {
    const { editor, input } = makeEditor({ completer: threeMatches });
    input.pushData("/");
    input.pushData("\t");
    await tick();
    input.pushData("x");
    await tick();
    expect(editor["lines"][0]).toBe("/alphax");
    expect(editor["completionSession"]).toBeNull();
    editor.close();
  });

  it("submits the selected candidate on Enter", async () => {
    const { editor, input, lines } = makeEditor({ completer: threeMatches });
    input.pushData("/");
    input.pushData("\t");
    await tick();
    input.pushData("\x1b[B"); // down -> /beta
    await tick();
    input.pushData("\r");
    await tick();
    expect(lines).toEqual(["/beta"]);
    expect(editor["completionSession"]).toBeNull();
  });

  it("wraps from the last candidate down to the first", async () => {
    const { editor, input } = makeEditor({ completer: threeMatches });
    input.pushData("/");
    input.pushData("\t");
    await tick();
    for (let i = 0; i < 3; i++) {
      input.pushData("\x1b[B");
      await tick();
    }
    expect(editor["lines"][0]).toBe("/alpha");
    editor.close();
  });

  it("wraps from the first candidate up to the last", async () => {
    const { editor, input } = makeEditor({ completer: threeMatches });
    input.pushData("/");
    input.pushData("\t");
    await tick();
    input.pushData("\x1b[A"); // up -> wrap to last
    await tick();
    expect(editor["lines"][0]).toBe("/gamma");
    editor.close();
  });

  it("completes a single match immediately with no session", async () => {
    const { editor, input, lines } = makeEditor({
      completer: () => [[{ value: "/sessions" }], "/s"],
    });
    input.pushData("/s");
    input.pushData("\t");
    await tick();
    expect(editor["lines"][0]).toBe("/sessions");
    expect(editor["completionSession"]).toBeNull();
    input.pushData("\r");
    await tick();
    expect(lines).toEqual(["/sessions"]);
  });

  it("beeps on zero matches and starts no session", async () => {
    const { editor, input, output } = makeEditor({
      completer: () => [[], "/z"],
    });
    output.data = "";
    input.pushData("/z");
    input.pushData("\t");
    await tick();
    expect(output.data).toContain("\x07");
    expect(editor["completionSession"]).toBeNull();
    editor.close();
  });
});
