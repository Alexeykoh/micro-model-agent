import { describe, it, expect } from "vitest";
import { box, wrapText, divider } from "../../src/ui/box";
import stringWidth from "string-width";

describe("wrapText", () => {
  it("wraps on word boundaries", () => {
    const lines = wrapText("one two three", 7);
    expect(lines).toEqual(["one two", "three"]);
  });

  it("hard-splits long tokens", () => {
    const lines = wrapText("abcdefgh", 4);
    expect(lines).toEqual(["abcd", "efgh"]);
  });

  it("handles empty input", () => {
    expect(wrapText("", 10)).toEqual([""]);
  });

  it("keeps ANSI width correct", () => {
    const colored = "\u001b[31mhello\u001b[39m world";
    const lines = wrapText(colored, 5);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(stringWidth(l)).toBeLessThanOrEqual(6);
  });
});

describe("box", () => {
  it("renders a bordered box", () => {
    const out = box(["hello"], { width: 30 });
    expect(out[0]).toContain("┌");
    expect(out[out.length - 1]).toContain("┘");
    expect(out.join("\n")).toContain("hello");
  });

  it("embeds the title in the top border", () => {
    const out = box(["x"], { title: "test", width: 30 });
    expect(out[0]).toContain("test");
  });

  it("wraps long content", () => {
    const out = box(["word ".repeat(50)], { width: 30 });
    expect(out.length).toBeGreaterThan(4);
  });

  it("respects minimum width", () => {
    const out = box(["x"], { width: 5 });
    expect(stringWidth(out[0])).toBeGreaterThanOrEqual(20);
  });
});

describe("divider", () => {
  it("returns a dim dashed line", () => {
    const d = divider(40);
    expect(stringWidth(d)).toBe(40);
  });

  it("caps at 60 columns", () => {
    const d = divider(200);
    expect(stringWidth(d)).toBe(60);
  });
});
