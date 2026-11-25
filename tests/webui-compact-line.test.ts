import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf-8");
const ICONS = read("../src/modules/webui/assets/js/icons.ts");
const WRITE = read("../src/modules/webui/assets/js/settings/selectors-write.ts");
const PROVIDER = read("../src/modules/webui/assets/js/settings/provider-selector.ts");

describe("compact selectors wiring", () => {
  it("adds the Lucide ruler icon", () => {
    expect(ICONS).toMatch(/\bruler:\s*\[/);
  });
  it("uses the shared builder instead of visible label prefixes", () => {
    expect(WRITE).toContain('from "./selector-line.js"');
    expect(WRITE).toContain("setCompactLabel(");
    expect(WRITE).not.toContain('btn.textContent = label + ":"');
    expect(WRITE).toContain('leadingIcon("ruler")');
  });
  it("keeps the provider brand icon", () => {
    expect(PROVIDER).toContain("providerIcon(active?.type, value)");
    expect(PROVIDER).toContain("setCompactLabel(");
  });
});

const HTML = read("../src/modules/webui/assets/index.html");
const CSS = read("../src/modules/webui/assets/styles.css");

describe("compact composer markup", () => {
  it("separates selectors with `/` and keeps every menu", () => {
    expect(HTML).toContain('<span class="selector-sep" aria-hidden="true">/</span>');
    for (const name of ["provider", "model", "context", "reasoning"]) {
      expect(HTML).toContain(`data-sel="${name}"`);
    }
    for (const id of ["selProviderMenu", "selModelMenu", "selContextMenu", "selReasoningMenu"]) {
      expect(HTML).toContain(`id="${id}"`);
    }
    // The chip must live inside model .sel: a hidden chip as the separator's
    // immediate sibling would hide the `/` while capabilities are unknown.
    expect(HTML).toMatch(/id="capsChip"[^<]*<\/span>\s*<\/div>\s*<span class="selector-sep"/);
  });

  it("drops chip surfaces and keeps the phone one-row rule", () => {
    expect(CSS).toMatch(/\.selectors\s*\{[^}]*flex-wrap:\s*nowrap/);
    expect(CSS).toMatch(/\.selectors > \.sel > button\s*\{[^}]*background:\s*none/);
    expect(CSS).toMatch(/\.sel\[data-sel="model"\]\s*\{\s*flex:\s*1 1 0/);
  });

  it("has a hint toggle for the compact hint row", () => {
    expect(HTML).toContain('id="hintMore"');
    expect(CSS).toMatch(/\.inp-meta\s+#hintShift\s*\{\s*display:\s*none/);
  });
});
