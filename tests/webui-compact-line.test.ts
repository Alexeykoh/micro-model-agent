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
