import { describe, it, expect } from "vitest";
import { extractReadableContent } from "../../src/tools/html-content";

/**
 * Тонкий `<main>` — это признак JS-шелла, а не повод откатиться на `<body>`
 * и отдать навигацию за контент (аудит §2.9, план
 * `2026-10-12-harness-module-audit-fixes`, W4/Task 4.3c).
 */

describe("extractReadableContent", () => {
  it("flags a thin <main> as a shell instead of falling back to <body>", () => {
    const html = `<body>${"<nav>Home About Contact Pricing Docs Blog</nav>".repeat(8)}<div id="root"></div></body>`;
    const r = extractReadableContent(html);
    expect(r.shell).toBe(true);
  });

  it("keeps navigation out of the extracted text when <main> is thin", () => {
    const html = `<body><nav>Home About Contact</nav><main><div id="root"></div></main></body>`;
    const r = extractReadableContent(html);
    expect(r.text).not.toContain("Home About Contact");
    expect(r.source).toBe("main");
  });

  it("takes the body when there is no main at all", () => {
    const html = `<body><p>${"plain page content ".repeat(30)}</p></body>`;
    const r = extractReadableContent(html);
    expect(r.source).toBe("body");
    expect(r.shell).toBe(false);
    expect(r.text).toContain("plain page content");
  });

  it("takes a dense main as content", () => {
    const html = `<body><nav>Home</nav><main><p>${"real content ".repeat(40)}</p></main></body>`;
    const r = extractReadableContent(html);
    expect(r.source).toBe("main");
    expect(r.shell).toBe(false);
    expect(r.text).toContain("real content");
  });
});
