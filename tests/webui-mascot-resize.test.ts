// Маскот, созданный скрытым (смена чата/субагент), не должен оставаться размытым 8×8.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync("src/modules/webui/assets/js/mascot-canvas.ts", "utf8");

describe("mascot backing store follows visibility", () => {
  it("re-measures when the face becomes visible", () => {
    expect(src).toMatch(/if \(row\.isIntersecting\) apply\(\)/);
  });

  it("re-checks the size periodically in the shared rAF loop", () => {
    expect(src).toContain("m.applySize?.()");
  });

  it("resizes the canvas backing store at device pixel ratio", () => {
    expect(src).toContain("this.canvas.width = Math.round(w * dpr)");
  });
});
