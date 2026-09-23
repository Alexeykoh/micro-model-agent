import { describe, it, expect, beforeEach } from "vitest";
import { setLocale } from "../../src/i18n/index";
import { formatMenu, choicePrompt } from "../../src/tools/user-input";

const options = [
  { label: "concise", description: "just the gist" },
  { label: "balanced", description: "default" },
];

describe("question rendering (STYLE)", () => {
  beforeEach(() => setLocale("en"));

  it("prefixes the question with the ? glyph", () => {
    const menu = formatMenu("Reply style?", options);
    expect(menu.split("\n")[0]).toBe("? Reply style?");
  });

  it("indents numbered options with label — description", () => {
    const menu = formatMenu("Reply style?", options);
    expect(menu).toContain("  [1] concise — just the gist");
    expect(menu).toContain("  [2] balanced — default");
  });

  it("appends the custom entry when allowCustom is set", () => {
    const menu = formatMenu("Reply style?", options, { allowCustom: true });
    expect(menu).toContain("[3]");
  });

  it("choice prompt starts with the > marker", () => {
    expect(choicePrompt(3, false).startsWith("> ")).toBe(true);
  });

  it("prefixes ? to the question line, leaving the header untouched", () => {
    const lines = formatMenu("Header\nQuestion?", options).split("\n");
    expect(lines[0]).toBe("Header");
    expect(lines[1]).toBe("? Question?");
  });

  it("keeps the header un-prefixed and prefixes the question on multi-line input", () => {
    const lines = formatMenu("Progress · Header\nWhich one?", options).split("\n");
    expect(lines[0]).toBe("Progress · Header");
    expect(lines[1]).toBe("? Which one?");
  });

  it("choice prompt for multiple starts with the > marker", () => {
    expect(choicePrompt(3, true).startsWith("> ")).toBe(true);
  });

  it("prefixes ? to the question under the ru locale", () => {
    setLocale("ru");
    expect(formatMenu("Стиль?", options).split("\n")[0].startsWith("? ")).toBe(true);
  });
});
