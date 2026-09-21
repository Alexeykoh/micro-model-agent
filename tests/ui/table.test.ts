import { describe, it, expect } from "vitest";
import {
  splitRow,
  isSeparatorRow,
  parseAlignments,
  formatTable,
  getTerminalWidth,
} from "../../src/ui/table";

describe("splitRow", () => {
  it("splits pipe rows", () => {
    expect(splitRow("| a | b | c |")).toEqual(["a", "b", "c"]);
  });

  it("handles rows without leading/trailing pipes", () => {
    expect(splitRow("a | b")).toEqual(["a", "b"]);
  });

  it("trims cell whitespace", () => {
    expect(splitRow("|  x  |  y |")).toEqual(["x", "y"]);
  });
});

describe("isSeparatorRow", () => {
  it("detects plain separators", () => {
    expect(isSeparatorRow("|---|---|")).toBe(true);
  });

  it("detects aligned separators", () => {
    expect(isSeparatorRow("| :--- | ---: | :---: |")).toBe(true);
  });

  it("rejects non-separators", () => {
    expect(isSeparatorRow("| a | b |")).toBe(false);
    expect(isSeparatorRow("hello world")).toBe(false);
  });
});

describe("parseAlignments", () => {
  it("parses left/right/center", () => {
    expect(parseAlignments("| :--- | ---: | :---: |")).toEqual({
      1: "right",
      2: "center",
    });
  });
});

describe("formatTable", () => {
  it("renders an aligned table without a box grid", () => {
    const out = formatTable(["| Name | Count |", "|---|---|", "| alpha | 1 |", "| beta | 22 |"], {
      maxWidth: 120,
    });
    const text = out.join("\n");
    expect(text).not.toContain("┌");
    expect(text).not.toContain("┐");
    expect(text).not.toContain("┘");
    expect(text).not.toContain("│");
    expect(out[0]).toContain("Name");
    expect(out[0]).toContain("Count");
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
  });

  it("respects right alignment from separator", () => {
    const out = formatTable(["| a | b |", "| :--- | ---: |", "| 1 | 2 |"], {
      maxWidth: 120,
    });
    const dataRow = out[out.length - 1];
    expect(dataRow).toContain("2");
  });

  it("drops empty trailing cells", () => {
    const out = formatTable(["| a |", "|---|", "| 1 |"], { maxWidth: 40 });
    expect(out.join("\n")).toContain("a");
    expect(out.join("\n")).toContain("1");
  });

  it("handles tables with only a header", () => {
    const out = formatTable(["| h1 | h2 |", "|---|---|"], { maxWidth: 40 });
    expect(out.join("\n")).toContain("h1");
  });
});

describe("getTerminalWidth", () => {
  it("returns a sane number", () => {
    expect(getTerminalWidth()).toBeGreaterThan(0);
  });
});
