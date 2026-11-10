// Square themes must not leave pill-shaped eyes in the canvas mascot.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { eyeGeometry } from "../src/modules/webui/assets/js/mascot-util.js";

const draw = readFileSync("src/modules/webui/assets/js/mascot-draw.ts", "utf8");

describe("mascot eye geometry", () => {
  it("squares eyes when the theme radius is zero", () => {
    expect(eyeGeometry(0, 10, 4)).toEqual({ h: 10, r: 0 });
  });

  it("keeps the pill radius for softer themes", () => {
    expect(eyeGeometry(0.5, 10, 4)).toEqual({ h: 4, r: 5 });
  });

  it("threads the resolved radius into every eye call", () => {
    expect(draw.match(/col\.eye, s\.radius\)/g)?.length).toBe(6);
  });
});