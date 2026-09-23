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
});
