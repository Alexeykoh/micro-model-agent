import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { WebUiAssets } from "./state";

const here = dirname(fileURLToPath(import.meta.url));

export function loadAssets(): WebUiAssets {
  const read = (name: string, fallback: string) => {
    const p = join(here, "assets", name);
    return existsSync(p) ? readFileSync(p, "utf8") : fallback;
  };
  return {
    html: read("index.html", "<!DOCTYPE html><h1>MMA web assets missing</h1>"),
    css: read("styles.css", "/* missing */"),
    js: read("app.js", "// missing"),
  };
}
