import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { WebUiAssets } from "./state";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Candidate directories, checked in order. In source, `here` is
 * `src/modules/webui` so the first entry is the real asset dir. In the bundle
 * (`dist/main.js`) `here` is `<dist>`, where `build:prod` copies the assets to
 * `assets/` (see `scripts/copy-assets.ts`); the remaining entries cover layouts
 * where the bundle sits elsewhere but the source tree is still present.
 */
const ASSET_DIR_CANDIDATES = [
  join(here, "assets"),
  join(here, "modules", "webui", "assets"),
  join(here, "..", "src", "modules", "webui", "assets"),
  join(here, "..", "..", "src", "modules", "webui", "assets"),
];

const ASSET_DIR = ASSET_DIR_CANDIDATES.find((d) => existsSync(join(d, "index.html")));

export function loadAssets(): WebUiAssets {
  const read = (name: string, fallback: string) => {
    if (!ASSET_DIR) return fallback;
    const p = join(ASSET_DIR, name);
    return existsSync(p) ? readFileSync(p, "utf8") : fallback;
  };
  return {
    html: read("index.html", "<!DOCTYPE html><h1>MMA web assets missing</h1>"),
    css: read("styles.css", "/* missing */"),
    js: read("app.js", "// missing"),
    setupJs: read("setup.js", "// missing"),
    mdJs: read("md.js", "// missing"),
    smdJs: read("smd.js", "// missing"),
    hljsJs: read("hljs.js", "// missing"),
  };
}
