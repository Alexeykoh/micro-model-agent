// CSS/layout guards for the 0.17.1 UI fixes.
//
// Unit tests assert `element.hidden === true`, but that does not prove the
// element is actually hidden: an author `display: flex/grid` rule beats the UA
// `[hidden]` rule. These guards pin the stylesheet rule that makes `hidden`
// authoritative, and the LSP button's inline icon alignment.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../src/modules/webui/assets/styles.css", import.meta.url), "utf-8");
const lspChanged = readFileSync(
  new URL("../src/modules/webui/assets/js/sidebar/lsp-changed.ts", import.meta.url),
  "utf-8",
);

describe("web UI layout guards", () => {
  it("makes the hidden attribute beat component display rules", () => {
    expect(css).toMatch(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/i);
  });

  it("keeps the LSP check button icon on the text baseline", () => {
    const rule = css.match(/\.lsp-file-go\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/display:\s*inline-flex/i);
    expect(rule).toMatch(/align-items:\s*center/i);
    expect(rule).toMatch(/gap:/i);
    expect(rule).toMatch(/white-space:\s*nowrap/i);
  });

  it("renders the LSP refresh icon before the label, not after it", () => {
    const icon = lspChanged.indexOf('btn.appendChild(icon("refresh"))');
    const label = lspChanged.indexOf("document.createTextNode");
    expect(icon).toBeGreaterThan(-1);
    expect(label).toBeGreaterThan(icon);
  });
});
