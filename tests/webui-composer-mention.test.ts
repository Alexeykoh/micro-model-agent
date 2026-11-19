// Static guard for the `@path` mention mirror: it must paint *behind* the
// textarea. With the overlay on top, the pill background hid the path and the
// composer looked like an empty grey bar.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync("src/modules/webui/assets/styles.css", "utf8");

describe("composer mention mirror stacking", () => {
  it("keeps the textarea above the mirror", () => {
    expect(css).toMatch(/\.inp-wrap \.inp \{[^}]*z-index: 1;/);
  });

  it("keeps the mirror behind the textarea", () => {
    expect(css).toMatch(/\.inp-mark \{[^}]*z-index: 0;/);
  });
});
