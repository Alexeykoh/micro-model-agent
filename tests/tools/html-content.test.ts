import { describe, it, expect } from "vitest";
import {
  extractMainContent,
  extractStructuredOffers,
  looksLikeShell,
} from "../../src/tools/html-content";
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

describe("extractStructuredOffers (JSON-LD)", () => {
  it("surfaces offers that live in a script tag far below the preview cut", () => {
    const html = `<html><head>
      <script type="application/ld+json" class="yoast-schema-graph">${JSON.stringify({
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": "OfferCatalog",
            itemListElement: [
              {
                item: {
                  "@type": "Offer",
                  name: "Разовое посещение",
                  price: "29",
                  priceCurrency: "BYN",
                  description: "Одно посещение в любое время суток, один клуб.",
                },
              },
              {
                item: {
                  "@type": "Offer",
                  name: "Подписка GYM24",
                  price: "99",
                  priceCurrency: "BYN",
                  description: "Первый месяц — 199 руб. (активация 100 + 99).",
                },
              },
            ],
          },
        ],
      })}</script>
    </head><body><main><p>Catalog visible text.</p></main></body></html>`;
    const offers = extractStructuredOffers(html);
    expect(offers).toContain("Разовое посещение | 29 BYN");
    expect(offers).toContain("Подписка GYM24 | 99 BYN");
    expect(offers).toContain("199");
    // Offer-блок должен попасть в текст, который видит web_fetch до обрезки.
    expect(extractMainContent(html).startsWith("STRUCTURED PAGE DATA")).toBe(true);
  });

  it("returns an empty string for pages without structured offers", () => {
    expect(extractStructuredOffers("<html><body><p>plain</p></body></html>")).toBe("");
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
