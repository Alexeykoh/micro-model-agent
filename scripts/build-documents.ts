// Bundles the CLI so that ONLY the documents module dependencies are inlined into
// `dist/main.js`; every other package (playwright, commander, …) stays external and
// resolves from `node_modules` at runtime — same semantics as `build:bundle`.
//
// The set of package names to keep external is derived from `package.json`
// `dependencies` minus `DOCUMENTS_DEPS`, so adding new deps never silently inlines
// them. See docs/specs/2026-10-16-documents-module-design.md §4.6.
import { readFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

/** Packages that MUST be embedded into the artifact (W0 spike, INV-D8). */
const DOCUMENTS_DEPS = ["fast-xml-parser", "pdfjs-dist"];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
};

const deps = Object.keys(pkg.dependencies ?? {});
const externals = deps.filter((name) => !DOCUMENTS_DEPS.includes(name));
const inlined = deps.filter((name) => DOCUMENTS_DEPS.includes(name));

process.stdout.write(`[build:documents] inline: ${inlined.join(", ") || "(none)"}\n`);
process.stdout.write(`[build:documents] external: ${externals.join(", ")}\n`);

const args = [
  "build",
  join(root, "src/cli/main.ts"),
  "--outfile",
  join(root, "dist/main.js"),
  "--target",
  "node",
  "--format",
  "esm",
  ...externals.flatMap((name) => ["--external", name]),
];

const proc = Bun.spawn(["bun", ...args], { stdio: ["inherit", "inherit", "inherit"] });
const code = await proc.exited;
if (code !== 0) {
  process.stderr.write(`[build:documents] bun build failed with exit code ${code}\n`);
  process.exit(code);
}
