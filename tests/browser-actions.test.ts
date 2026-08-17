import { describe, it, expect } from "vitest";
import {
  buildClickScript,
  buildTypeScript,
  buildScrollScript,
  buildTextExtractionScript,
} from "../src/modules/browser/actions";

describe("buildClickScript", () => {
  it("generates script that clicks element by index", () => {
    const script = buildClickScript(3);
    expect(script).toContain("data-browser-index");
    expect(script).toContain("3");
    expect(script).toContain(".click()");
  });
});

describe("buildTypeScript", () => {
  it("generates script that types text into element", () => {
    const script = buildTypeScript(2, "hello world");
    expect(script).toContain("data-browser-index");
    expect(script).toContain("2");
    expect(script).toContain("hello world");
    expect(script).toContain(".value");
  });

  it("escapes special characters in text", () => {
    const script = buildTypeScript(1, 'test"quote\\backslash');
    expect(script).not.toContain('test"quote');
    expect(script).toContain("JSON.parse");
  });
});

describe("buildScrollScript", () => {
  it("generates scroll down script", () => {
    const script = buildScrollScript("down");
    expect(script).toContain("scrollBy");
    expect(script).toContain("600");
  });

  it("generates scroll up script", () => {
    const script = buildScrollScript("up");
    expect(script).toContain("scrollBy");
    expect(script).toContain("-600");
  });
});

describe("buildTextExtractionScript", () => {
  it("targets content tags and filters hidden elements", () => {
    const script = buildTextExtractionScript();
    expect(script).toContain("h1");
    expect(script).toContain("createTreeWalker");
    expect(script).toContain("display");
    expect(script).toContain("visibility");
  });

  it("deduplicates repeated text", () => {
    const script = buildTextExtractionScript();
    expect(script).toContain("seen");
  });
});
