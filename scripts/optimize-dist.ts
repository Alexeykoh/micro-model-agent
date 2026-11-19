// Minify every JS/CSS/JSON artifact in `dist` in place via esbuild. Minification
// also mangles identifiers (light obfuscation). No source maps — nothing shipped
// to reverse with.
import { readdir, readFile, writeFile } from "fs/promises";
import { dirname, extname, join } from "path";
import { fileURLToPath } from "url";
import { transform } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

const LOADERS: Record<string, "js" | "css"> = {
  ".js": "js",
  ".mjs": "js",
  ".css": "css",
};

async function minifyText(full: string, loader: "js" | "css"): Promise<void> {
  const source = await readFile(full, "utf8");
  // `charset: "utf8"` keeps non-ASCII (Cyrillic i18n strings) as-is instead of
  // escaping to `\uXXXX` (which inflated ru dictionaries ~2x).
  const result = await transform(source, { loader, minify: true, charset: "utf8", legalComments: "none" });
  await writeFile(full, result.code);
}

async function minifyJson(full: string): Promise<void> {
  const source = await readFile(full, "utf8");
  await writeFile(full, JSON.stringify(JSON.parse(source)));
}

async function emit(full: string, ext: string): Promise<void> {
  const loader = LOADERS[ext];
  if (loader) await minifyText(full, loader);
  else if (ext === ".json") await minifyJson(full);
}

async function walk(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else await emit(full, extname(entry.name));
  }
}

await walk(dist);
