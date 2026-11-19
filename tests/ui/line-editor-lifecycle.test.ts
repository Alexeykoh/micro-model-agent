import { describe, it, expect } from "vitest";
import { Readable } from "stream";
import { LineEditor } from "../../src/ui/line-editor";
import { Renderer } from "../../src/ui/renderer";

/**
 * Жизненный цикл терминала: Ctrl+D на пустой строке завершает сессию чисто, а
 * resize перемеряет ширину (аудит §8.11/§8.12, план
 * `2026-10-12-harness-module-audit-fixes`, W9/Task 9.2).
 */

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

function makeEditor() {
  const input = new FakeInput();
  const output = new FakeOutput();
  const editor = new LineEditor({
    input: input as never,
    output: output as never,
    prompt: "> ",
  });
  return { editor, input, output };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("line-editor: жизненный цикл", () => {
  it("Ctrl+D on an empty line ends the session cleanly", async () => {
    const { editor, input } = makeEditor();
    let closed = 0;
    editor.on("close", () => {
      closed++;
    });

    input.pushData("\x04");
    await tick();
    expect(closed).toBe(1);
    expect(editor.isDone()).toBe(true);
  });

  it("Ctrl+D inside a line deletes the character instead of closing", async () => {
    const { editor, input } = makeEditor();
    let closed = 0;
    editor.on("close", () => {
      closed++;
    });

    input.pushData("ab");
    await tick();
    input.pushData("\x04");
    await tick();
    expect(closed).toBe(0);
    expect(editor.isDone()).toBe(false);
  });
});

describe("renderer: resize", () => {
  it("re-measures the terminal width on resize", () => {
    const renderer = new Renderer({ width: 80 });
    renderer.onResize(120);
    expect(renderer.width).toBe(120);
  });
});
