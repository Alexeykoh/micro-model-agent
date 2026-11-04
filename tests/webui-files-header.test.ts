/**
 * U8 (UX-аудит WebUI 2026-11-02): поиск в Files делил одну строку с тремя
 * иконками и в узком сайдбаре схлопывался до «поиск по фай…», а очистка была
 * только на Escape. Гейт держит структуру: внутренний хэдер + отдельная строка
 * поиска на всю ширину + видимая кнопка очистки.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const HTML = readFileSync(
  new URL("../src/modules/webui/assets/index.html", import.meta.url),
  "utf-8",
);
const CSS = readFileSync(
  new URL("../src/modules/webui/assets/styles.css", import.meta.url),
  "utf-8",
);

describe("files tab header (U8)", () => {
  it("separates tree controls from the search row", () => {
    expect(HTML).toContain('class="files-head"');
    expect(HTML).toContain('class="files-search-row"');
    expect(HTML).not.toContain('class="files-bar"');
    // The field and its clear button share a row; the tree buttons do not.
    const head = HTML.slice(HTML.indexOf('class="files-head"'), HTML.indexOf('class="files-search-row"'));
    expect(head).not.toContain("filesSearch");
    const row = HTML.slice(
      HTML.indexOf('class="files-search-row"'),
      HTML.indexOf('id="filesTree"'),
    );
    expect(row).toContain('id="filesSearch"');
    expect(row).toContain('id="filesSearchClear"');
  });

  it("gives the search field the full row width", () => {
    expect(CSS).toMatch(/\.files-search-row\s*\{[^}]*display:\s*flex/);
    expect(CSS).toMatch(/\.files-search-row \.fsearch\s*\{[^}]*height:\s*26px/);
    expect(CSS).toMatch(/\.files-head-title\s*\{[^}]*text-overflow:\s*ellipsis/);
  });
});
