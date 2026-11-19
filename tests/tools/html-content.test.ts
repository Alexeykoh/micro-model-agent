import { describe, it, expect } from "vitest";
import { extractMainContent, looksLikeShell } from "../../src/tools/html-content";
import { unwrapDdgUrl } from "../../src/tools/web-search";

describe("extractMainContent", () => {
  it("prefers <main> over surrounding navigation", () => {
    const html = `
      <html><body>
        <nav>Home About Products Contact</nav>
        <main>
          <h1>Specialized Rockhopper</h1>
          <p>The Rockhopper is a versatile trail hardtail with a lightweight alloy frame and reliable components.</p>
        </main>
        <footer>Copyright 2026</footer>
      </body></html>`;
    const text = extractMainContent(html);
    expect(text).toContain("Rockhopper");
    expect(text).not.toContain("Home About Products");
    expect(text).not.toContain("Copyright");
  });

  it("drops script/style content", () => {
    const html = `<main><script>var x=1;</script><style>.a{color:red}</style><p>Real text here that is long enough to matter for the extractor threshold.</p></main>`;
    const text = extractMainContent(html);
    expect(text).not.toContain("var x");
    expect(text).not.toContain("color:red");
    expect(text).toContain("Real text");
  });
});

describe("looksLikeShell", () => {
  it("flags a big markup page with almost no text", () => {
    const raw = `<html><head>${"<script src='x.js'></script>".repeat(200)}</head><body><div id="app"></div></body></html>`;
    expect(looksLikeShell(raw, "")).toBe(true);
  });

  it("does not flag a small genuine page", () => {
    const raw = "<html><body><p>Short.</p></body></html>";
    expect(looksLikeShell(raw, "Short.")).toBe(false);
  });
});

describe("unwrapDdgUrl", () => {
  it("unwraps a DuckDuckGo redirect to the direct URL", () => {
    expect(
      unwrapDdgUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=abc"),
    ).toBe("https://example.com/a");
  });

  it("passes through non-DDG URLs unchanged", () => {
    expect(unwrapDdgUrl("https://example.com/b")).toBe("https://example.com/b");
  });
});
