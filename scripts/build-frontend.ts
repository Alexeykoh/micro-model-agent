// Transpiles the `mma web` browser frontend (TypeScript under
// `src/modules/webui/assets`) into `dist/assets`, preserving file names and the
// ES-module graph the browser imports (`/app.js`, `/js/*.js`). Vendored `.js`
// (smd/hljs) and html/css are copied verbatim.
import { cp, mkdir, readdir, readFile, rm, writeFile } from "fs/promises";
import { dirname, join, relative } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src", "modules", "webui", "assets");
const outDir = join(root, "dist", "assets");
const transpiler = new Bun.Transpiler({ loader: "ts" });

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

// Transpile a `.ts` source to `.js` (skip type-only modules that emit nothing);
// copy any other file (vendored `.js`, html, css) verbatim.
async function emit(full: string, dest: string): Promise<void> {
  if (!full.endsWith(".ts")) {
    await cp(full, dest);
    return;
  }
  const js = transpiler.transformSync(await readFile(full, "utf8"));
  if (js.trim()) await writeFile(dest.replace(/\.ts$/, ".js"), js);
}

async function walk(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const dest = join(outDir, relative(srcDir, full));
    if (entry.isDirectory()) {
      await mkdir(dest, { recursive: true });
      await walk(full);
      continue;
    }
    await emit(full, dest);
  }
}

await walk(srcDir);
