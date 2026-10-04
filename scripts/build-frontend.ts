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

async function walk(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const dest = join(outDir, relative(srcDir, full));
    if (entry.isDirectory()) {
      await mkdir(dest, { recursive: true });
      await walk(full);
      continue;
    }
    if (entry.name.endsWith(".ts")) {
      const js = transpiler.transformSync(await readFile(full, "utf8"));
      await writeFile(dest.replace(/\.ts$/, ".js"), js);
    } else {
      await cp(full, dest);
    }
  }
}

await walk(srcDir);
