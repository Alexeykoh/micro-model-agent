// Bundles the canvas mascot for the static landing page. `gh-pages/` has no
// build step at serve time, so this script writes a ready-to-load ES module.
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const result = await Bun.build({
  entrypoints: [join(root, "src/modules/webui/assets/js/mascot-landing.ts")],
  outdir: join(root, "gh-pages"),
  naming: "mascot-canvas.js",
  format: "esm",
  target: "browser",
  minify: false,
});

if (!result.success) {
  for (const log of result.logs) process.stderr.write(`${log}\n`);
  process.exit(1);
}
process.stdout.write("wrote gh-pages/mascot-canvas.js\n");
