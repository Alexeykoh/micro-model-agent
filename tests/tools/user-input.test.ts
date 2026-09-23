import { describe, it, expect, beforeEach } from "vitest";
import { setLocale } from "../../src/i18n/index";
import { parseSelection, formatMenu, choicePrompt } from "../../src/tools/user-input";

describe("parseSelection", () => {
  it("parses a single valid choice", () => {
    expect(parseSelection("2", 3, false)).toEqual([1]);
  });

  it("parses multiple comma-separated choices", () => {
    expect(parseSelection("1,3", 3, true)).toEqual([0, 2]);
  });

  it("trims whitespace around numbers", () => {
    expect(parseSelection(" 1 , 2 ", 3, true)).toEqual([0, 1]);
  });

  it("rejects empty input", () => {
    expect(parseSelection("", 3, false)).toBeNull();
    expect(parseSelection("   ", 3, false)).toBeNull();
  });

  it("rejects non-numeric input", () => {
    expect(parseSelection("abc", 3, false)).toBeNull();
    expect(parseSelection("1,b", 3, true)).toBeNull();
  });

  it("rejects out-of-range choices", () => {
    expect(parseSelection("0", 3, false)).toBeNull();
    expect(parseSelection("4", 3, false)).toBeNull();
  });

  it("rejects duplicates", () => {
    expect(parseSelection("1,1", 3, true)).toBeNull();
  });

  it("rejects multiple values in single-choice mode", () => {
    expect(parseSelection("1,2", 3, false)).toBeNull();
  });
});

describe("formatMenu", () => {
  beforeEach(() => {
    setLocale("en");
  });

  const options = [
    { label: "React", description: "Library from Meta" },
    { label: "Vue", description: "Progressive framework" },
  ];

  it("renders question with numbered options", () => {
    const menu = formatMenu("Pick a framework", options);
    expect(menu.split("\n")[0]).toBe("? Pick a framework");
    expect(menu).toContain("  [1] React — Library from Meta");
    expect(menu).toContain("  [2] Vue — Progressive framework");
    expect(menu).not.toContain("[3]");
  });

  it("appends custom entry when allowCustom is set", () => {
    const menu = formatMenu("Pick a framework", options, { allowCustom: true });
    expect(menu).toContain("[3] Type your own answer");
  });
});

describe("choicePrompt", () => {
  beforeEach(() => {
    setLocale("en");
  });

  it("shows range for single choice", () => {
    expect(choicePrompt(3, false)).toContain("1-3");
  });

  it("shows comma hint for multiple choice", () => {
    expect(choicePrompt(3, true)).toContain("comma");
  });
});
