// The site has no build step at serve time: `gh-pages/mascot-canvas.js`
// is generated from the same TS sources as the web UI. This guard fails if the
// wiring disappears or the bundle stops exposing the API the pages use.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const PAGES = join(REPO_ROOT, "gh-pages");
const BUNDLE = readFileSync(join(PAGES, "mascot-canvas.js"), "utf8");
const HTML = readFileSync(join(PAGES, "index.html"), "utf8");
const DOCS = readFileSync(join(PAGES, "docs.html"), "utf8");
const APP = readFileSync(join(PAGES, "app.js"), "utf8");
const CSS = readFileSync(join(PAGES, "mascot.css"), "utf8");

describe("landing mascot", () => {
  it("ships the generated canvas bundle as a module", () => {
    expect(HTML).toContain('type="module" src="mascot-canvas.js"');
    expect(DOCS).toContain('type="module" src="mascot-canvas.js"');
    expect(BUNDLE).toContain("MMART");
    expect(BUNDLE.length).toBeGreaterThan(10000);
  });

  it("is the only renderer for landing faces", () => {
    expect(APP).not.toContain('class="eyes"');
    expect(APP).toContain("window.MMART.attach");
    expect(APP).toContain("window.MMART.lookAt");
  });

  it("drives the state lab on the docs page through the same bundle", () => {
    expect(DOCS).toContain("window.MMART.setState");
    expect(DOCS).toContain('id="mascotBig"');
    expect(DOCS).toMatch(/class="mascot-strip/);
  });

  it("keeps the canvas geometry rules in the landing stylesheet", () => {
    expect(CSS).toContain(".mdl.has-canvas canvas");
    expect(CSS).toContain("width: 180%");
  });
});
