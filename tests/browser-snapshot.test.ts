import { describe, it, expect } from "vitest";
import {
  extractInteractiveElements,
  formatSnapshot,
  truncateText,
  type ElementEntry,
} from "../src/modules/browser/snapshot";

describe("extractInteractiveElements", () => {
  it("extracts links, buttons, inputs from HTML", () => {
    const html = `
      <html><body>
        <a href="https://example.com">Example Link</a>
        <button>Click Me</button>
        <input type="text" placeholder="Search" />
        <textarea placeholder="Comment"></textarea>
        <div role="button" aria-label="Toggle">X</div>
        <p>Not interactive</p>
      </body></html>
    `;
    const elements = extractInteractiveElements(html);
    expect(elements.length).toBe(5);
    expect(elements[0].role).toBe("link");
    expect(elements[1].role).toBe("button");
    expect(elements[2].role).toBe("textbox");
    expect(elements[3].role).toBe("textbox");
    expect(elements[4].role).toBe("button");
  });

  it("assigns sequential indices starting from 1", () => {
    const html = `<html><body><a href="/a">A</a><a href="/b">B</a></body></html>`;
    const elements = extractInteractiveElements(html);
    expect(elements[0].index).toBe(1);
    expect(elements[1].index).toBe(2);
  });

  it("respects maxElements limit", () => {
    const links = Array.from({ length: 50 }, (_, i) => `<a href="/${i}">Link ${i}</a>`).join("");
    const html = `<html><body>${links}</body></html>`;
    const elements = extractInteractiveElements(html, 10);
    expect(elements.length).toBe(10);
  });

  it("skips hidden elements", () => {
    const html = `<html><body>
      <a href="/visible">Visible</a>
      <a href="/hidden" style="display:none">Hidden</a>
    </body></html>`;
    const elements = extractInteractiveElements(html);
    expect(elements.length).toBe(1);
    expect(elements[0].name).toBe("Visible");
  });
});

describe("formatSnapshot", () => {
  const base = {
    url: "https://example.com",
    title: "Example",
    elements: [] as ElementEntry[],
    content: "",
    console: [],
    networkErrors: [],
  };

  it("formats elements as numbered list", () => {
    const elements: ElementEntry[] = [
      { index: 1, tag: "a", role: "link", name: "Home", href: "/", visible: true },
      { index: 2, tag: "input", role: "textbox", name: "Search", visible: true },
    ];
    const output = formatSnapshot({ ...base, elements });
    expect(output).toContain('Page: "Example"');
    expect(output).toContain("URL: https://example.com");
    expect(output).toContain('[1] link "Home"');
    expect(output).toContain('[2] textbox "Search"');
  });

  it("shows truncation notice when truncated", () => {
    const output = formatSnapshot({ ...base, truncated: true });
    expect(output).toContain("more elements");
  });

  it("includes visible page content section", () => {
    const output = formatSnapshot({
      ...base,
      content: "[h1] Example Domain\n[p] This is a test paragraph.",
    });
    expect(output).toContain("Content:");
    expect(output).toContain("- [h1] Example Domain");
    expect(output).toContain("- [p] This is a test paragraph.");
  });

  it("includes console messages section", () => {
    const output = formatSnapshot({
      ...base,
      console: [
        { type: "log", text: "Hello" },
        { type: "error", text: "Uncaught TypeError" },
      ],
    });
    expect(output).toContain("Console:");
    expect(output).toContain("[log] Hello");
    expect(output).toContain("[error] Uncaught TypeError");
  });

  it("includes network errors section", () => {
    const output = formatSnapshot({
      ...base,
      networkErrors: [
        { method: "GET", url: "https://example.com/x.png", error: "net::ERR_NAME_NOT_RESOLVED" },
      ],
    });
    expect(output).toContain("Network errors:");
    expect(output).toContain("GET https://example.com/x.png");
    expect(output).toContain("net::ERR_NAME_NOT_RESOLVED");
  });

  it("omits empty sections", () => {
    const output = formatSnapshot({ ...base });
    expect(output).not.toContain("Content:");
    expect(output).not.toContain("Console:");
    expect(output).not.toContain("Network errors:");
  });
});

describe("truncateText", () => {
  it("returns text unchanged when under limit", () => {
    expect(truncateText("short", 100)).toBe("short");
  });

  it("truncates long text with marker", () => {
    const text = "a".repeat(100);
    const out = truncateText(text, 20);
    expect(out).toContain("truncated");
    expect(out.length).toBeLessThan(text.length);
  });

  it("returns empty string for non-positive limit", () => {
    expect(truncateText("abc", 0)).toBe("");
  });
});
