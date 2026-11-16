// CSS/layout guards for the 0.17.1 UI fixes.
//
// Unit tests assert `element.hidden === true`, but that does not prove the
// element is actually hidden: an author `display: flex/grid` rule beats the UA
// `[hidden]` rule. These guards pin the stylesheet rule that makes `hidden`
// authoritative, and the LSP button's inline icon alignment.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("../src/modules/webui/assets/styles.css", import.meta.url),
  "utf-8",
);
const lspChanged = readFileSync(
  new URL("../src/modules/webui/assets/js/sidebar/lsp-changed.ts", import.meta.url),
  "utf-8",
);
const tableEditor = readFileSync(
  new URL("../src/modules/webui/assets/js/settings/table-editor.ts", import.meta.url),
  "utf-8",
);
const panelsShared = readFileSync(
  new URL("../src/modules/webui/assets/js/settings/panels-shared.ts", import.meta.url),
  "utf-8",
);
const capabilitiesRegistry = readFileSync(
  new URL("../src/config/registry-extra-capabilities.ts", import.meta.url),
  "utf-8",
);
const pluginsPanel = readFileSync(
  new URL("../src/modules/webui/assets/js/settings/panels-plugins.ts", import.meta.url),
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

  it("gives settings text fields readable widths (not a 120px clip)", () => {
    const rule = css.match(/\.row > input:not\(\[type="number"\]\)[\s\S]*?\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/width:\s*min\(340px,\s*100%\)/i);
    expect(css).toMatch(/\.row > select\s*\{[\s\S]*?width:\s*min\(340px,\s*100%\)/i);
  });

  it("keeps provider-form cells and the provider dialog wide enough", () => {
    const grid = css.match(/\.pform-grid\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(grid).toMatch(/minmax\(220px,\s*1fr\)/i);
    expect(css).toMatch(/#subOverlay:has\(\.pform-base\)[^{]*\{[^}]*width:\s*min\(720px/i);
  });

  it("gives table editor columns explicit tracks instead of clipped implicit ones", () => {
    expect(tableEditor).toContain("trackTemplate");
    expect(tableEditor).toContain("minmax(120px, 1fr)");
    expect(tableEditor).not.toContain("repeat(auto-fit, minmax(84px");
    expect(tableEditor).toContain("elRow.style.gridTemplateColumns = trackTemplate");
  });

  it("keeps the wizard and its fields wide enough to read", () => {
    expect(css).toMatch(/\.setup-wrap\s*\{[^}]*max-width:\s*640px/i);
    expect(css).toMatch(/\.setup-modal\s*\{[^}]*max-width:\s*640px/i);
    const input = css.match(/\.setup-input\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(input).toMatch(/width:\s*100%/i);
  });

  it("makes the security master switch visually dominant without a left gutter", () => {
    expect(panelsShared).toContain('key === "security.enabled"');
    expect(panelsShared).toContain('"row-master"');
    expect(panelsShared).toContain("master-card");
    const rule = css.match(/\.row-master\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/border:\s*1px solid var\(--accent\)/i);
    expect(rule).toMatch(/background:\s*var\(--accent-bg\)/i);
    expect(rule).toMatch(/padding:\s*12px 14px/i);
    const name = css.match(/\.row-master \.row-name\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(name).toMatch(/font-size:\s*15px/i);
    expect(name).toMatch(/color:\s*var\(--accent\)/i);
    expect(panelsShared).toContain('section.master ? " master-card"');
  });

  it("stacks wide record tables vertically", () => {
    expect(tableEditor).toContain('editor.layout === "stack"');
    expect(tableEditor).toContain("table-row-stack");
    expect(tableEditor).toContain("table-field-label");
    expect(css).toMatch(/\.table-stack \.table-row\s*\{[^}]*grid-template-columns:\s*1fr/i);
    expect(capabilitiesRegistry).toMatch(/jsonShape\("experts"[\s\S]*?layout:\s*"stack"/);
  });

  it("splits Plugins/MCP/LSP into focused sub-tabs", () => {
    expect(pluginsPanel).toContain('"settings-tabs"');
    expect(pluginsPanel).toContain('["mcp", "web.settings.tab_mcp"]');
    expect(pluginsPanel).toContain('["lsp", "web.settings.tab_lsp"]');
    expect(pluginsPanel).toContain("renderMcpSection");
    expect(pluginsPanel).not.toContain('renderSections("plugins"');
    expect(css).toMatch(/\.settings-tabs\s*,?[\s\S]*?border-bottom:/);
  });

  it("keeps the setup footer reachable and the intro responsive", () => {
    const actionRules = [...css.matchAll(/\.setup-actions\s*\{([^}]*)\}/g)].map((m) => m[1]);
    expect(actionRules.some((r) => /position:\s*sticky/i.test(r) && /bottom:\s*0/i.test(r))).toBe(
      true,
    );
    expect(css).toContain(".setup-intro-needs { grid-template-columns: 1fr; row-gap: 8px; }");
    expect(css).toMatch(/@media \(max-width: 560px\)\s*\{[\s\S]*?\.setup-intro-needs/);
  });
});
