// The boot/load face is a calm squircle: no dashed ring, no orbiting dots and
// no shadow ellipse under the body.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const { STATE_CFG } = await import("../src/modules/webui/assets/js/mascot-pose.js");
const css = readFileSync("src/modules/webui/assets/styles.css", "utf8");
const draw = readFileSync("src/modules/webui/assets/js/mascot-draw.ts", "utf8");

describe("calm boot mascot", () => {
  it("has no orbit effect on boot/load", () => {
    expect(STATE_CFG.load.fx.some((f) => f.type === "orbit")).toBe(false);
    expect(STATE_CFG.boot.fx.some((f) => f.type === "orbit")).toBe(false);
  });

  it("has no dashed ring/spin on the boot state", () => {
    expect(css).not.toContain("mdlSpin");
    expect(css).not.toMatch(/\.mdl\.st-boot \{[^}]*border-radius: 50%/);
  });

  it("draws no shadow ellipse under the body", () => {
    expect(draw).not.toContain("createRadialGradient");
  });
});
