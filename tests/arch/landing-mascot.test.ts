// The landing page has no build step at serve time: `gh-pages/mascot-canvas.js`
// is generated from the same TS sources as the web UI. This guard fails if the
// wiring disappears or the bundle stops exposing the API `app.js` uses.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const BUNDLE = readFileSync(join(REPO_ROOT, "gh-pages/mascot-canvas.js"), "utf8");
const HTML = readFileSync(join(REPO_ROOT, "gh-pages/index.html"), "utf8");
const APP = readFileSync(join(REPO_ROOT, "gh-pages/app.js"), "utf8");

describe("landing mascot", () => {
  it("ships the generated canvas bundle as a module", () => {
    expect(HTML).toContain('type="module" src="mascot-canvas.js"');
    expect(BUNDLE).toContain("MMART");
    expect(BUNDLE.length).toBeGreaterThan(10000);
  });

  it("is the only renderer for landing faces", () => {
    expect(APP).not.toContain('class="eyes"');
    expect(APP).toContain("window.MMART.attach");
    expect(APP).toContain("window.MMART.setState");
  });

  it("keeps the canvas geometry rules in the landing stylesheet", () => {
    const css = readFileSync(join(REPO_ROOT, "gh-pages/mascot.css"), "utf8");
    expect(css).toContain(".mdl.has-canvas canvas");
    expect(css).toContain("width: 180%");
  });
});
