import { describe, it, expect, beforeEach, vi } from "vitest";
import { createPromptIO } from "../../src/tools/prompt-io";
import { CUSTOM_INDEX } from "../../src/tools/user-input";
import { setLocale } from "../../src/i18n/index";

function scripted(answers: string[]) {
  let i = 0;
  const ask = vi.fn(async (_prompt: string) => answers[i++] ?? "");
  const print = vi.fn<(line: string) => void>();
  const io = createPromptIO({ ask, print });
  return { io, ask, print };
}

const options = [
  { label: "React", description: "Library from Meta" },
  { label: "Vue", description: "Progressive framework" },
];

describe("createPromptIO", () => {
  beforeEach(() => {
    setLocale("en");
  });

  it("returns trimmed free text", async () => {
    const { io } = scripted(["  hello world  "]);
    expect(await io.askText("Name?")).toBe("hello world");
  });

  it("appends a space to the free-text prompt", async () => {
    const { io, ask } = scripted(["x"]);
    await io.askText("Name?");
    expect(ask).toHaveBeenCalledWith("Name? ");
  });

  it("parses a single choice", async () => {
    const { io } = scripted(["1"]);
    expect(await io.askChoice("Pick", options)).toEqual([0]);
  });

  it("parses comma-separated multiple choices", async () => {
    const { io } = scripted(["1,3"]);
    expect(await io.askChoice("Pick", options, { multiple: true, allowCustom: true })).toEqual([
      0,
      CUSTOM_INDEX,
    ]);
  });

  it("re-asks on invalid input and prints the menu once", async () => {
    const { io, ask, print } = scripted(["nope", "2"]);
    expect(await io.askChoice("Pick", options)).toEqual([1]);
    expect(ask).toHaveBeenCalledTimes(2);
    // Menu printed once up-front, invalid notice printed after the bad answer.
    expect(print).toHaveBeenCalledTimes(2);
    expect(print.mock.calls[1][0]).toContain("Invalid");
  });

  it("maps the custom entry to CUSTOM_INDEX", async () => {
    const { io } = scripted(["3"]);
    expect(await io.askChoice("Pick", options, { allowCustom: true })).toEqual([CUSTOM_INDEX]);
  });

  it("prints the rendered menu", async () => {
    const { io, print } = scripted(["1"]);
    await io.askChoice("Pick a framework", options, { allowCustom: true });
    const menu = print.mock.calls[0][0];
    expect(menu).toContain("Pick a framework");
    expect(menu).toContain("[1] React — Library from Meta");
    expect(menu).toContain("[3] Type your own answer");
  });
});
