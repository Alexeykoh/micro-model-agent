import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "stream";
import { SetupPrompt } from "../../src/cli/setup-prompt";

function makeInput(): {
  input: PassThrough & { setRawMode: ReturnType<typeof vi.fn> };
  output: NodeJS.WritableStream;
  out: string[];
} {
  const input = new PassThrough() as PassThrough & { setRawMode: ReturnType<typeof vi.fn> };
  input.setRawMode = vi.fn();
  const out: string[] = [];
  const output = {
    write: (s: string) => {
      out.push(s);
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { input, output, out };
}

describe("SetupPrompt", () => {
  it("uses cooked mode and writes the prompt", () => {
    const { input, output, out } = makeInput();
    const p = new SetupPrompt(input, output);
    expect(input.setRawMode).toHaveBeenCalledWith(false);
    p.question("Q: ", () => {});
    expect(out.join("")).toContain("Q: ");
    p.close();
  });

  it("resolves a question on a CRLF-terminated line", () => {
    const { input, output } = makeInput();
    const p = new SetupPrompt(input, output);
    const answers: string[] = [];
    p.question("Q: ", (a) => answers.push(a));
    input.write("42\r\n");
    expect(answers).toEqual(["42"]);
    p.close();
  });

  it("joins input split across chunks", () => {
    const { input, output } = makeInput();
    const p = new SetupPrompt(input, output);
    const answers: string[] = [];
    p.question("Q: ", (a) => answers.push(a));
    input.write("4");
    input.write("2");
    expect(answers).toEqual([]);
    input.write("\n");
    expect(answers).toEqual(["42"]);
    p.close();
  });

  it("does not resolve after close", () => {
    const { input, output } = makeInput();
    const p = new SetupPrompt(input, output);
    const cb = vi.fn();
    p.question("Q: ", cb);
    p.close();
    input.write("late\n");
    expect(cb).not.toHaveBeenCalled();
  });

  it("routes sequential answers to the right question", () => {
    const { input, output } = makeInput();
    const p = new SetupPrompt(input, output);
    const first = vi.fn();
    const second = vi.fn();
    p.question("1: ", first);
    input.write("a\n");
    p.question("2: ", second);
    input.write("b\n");
    expect(first).toHaveBeenCalledWith("a");
    expect(second).toHaveBeenCalledWith("b");
    p.close();
  });
});
