import { describe, it, expect } from "vitest";
import { formatMarkdown } from "../../src/ui/md-formatter";
import { normalizeMarkdown } from "../../src/ui/md-normalize";
import { normalizeMarkdown as normalizeMarkdownWeb } from "../../src/modules/webui/assets/js/md-normalize";

/**
 * Терминал и веб понимают один и тот же Markdown: `##Title`, GFM-таблицы без
 * внешних `|`, списки `1)` (аудит §8.13, план
 * `2026-10-12-harness-module-audit-fixes`, W8/Task 9.3).
 */

/** Фикстуры: терминальная копия нормализатора и вебовая обязаны совпадать. */
const FIXTURES: string[] = [
  "##Title\n\ntext",
  "# H1\n## H2\n### H3",
  "col1 | col2\n--- | ---\na | b",
  "| col1 | col2 |\n| --- | --- |\n| a | b |",
  "1) first\n2) second",
  "```ts\nconst a = 1;\n```",
  "текст с `|` в строке",
  "- пункт\n- другой",
  "> цитата | с палкой",
  "",
];

describe("терминальный markdown: паритет с вебом", () => {
  it("renders a heading without a space as a heading", () => {
    const out = formatMarkdown("##Title\n\nbody");
    expect(out).toContain("Title");
    expect(out).not.toContain("## Title");
  });

  it("renders a pipe-less GFM table as a table", () => {
    const out = formatMarkdown("col1 | col2\n--- | ---\na | b");
    expect(out).toMatch(/col1\s+col2/);
    expect(out).toMatch(/a\s+b/);
  });

  it("renders a `1)` list as an ordered list", () => {
    const out = formatMarkdown("1) first\n2) second");
    expect(out).toContain("1.");
    expect(out).not.toContain("1)");
  });

  it("the terminal and the web normalizer agree on every fixture", () => {
    for (const fixture of FIXTURES) {
      expect(normalizeMarkdown(fixture), `фикстура: ${JSON.stringify(fixture)}`).toBe(
        normalizeMarkdownWeb(fixture),
      );
    }
  });
});
