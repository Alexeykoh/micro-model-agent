// Bundles the CLI so that ONLY the documents module dependencies are inlined into
// `dist/main.js`; every other package (playwright, commander, …) stays external and
// resolves from `node_modules` at runtime — same semantics as `build:bundle`.
//
// The set of package names to keep external is derived from `package.json`
// `dependencies` minus `DOCUMENTS_DEPS`, so adding new deps never silently inlines
// them. See docs/specs/2026-10-16-documents-module-design.md §4.6.
import { mkdir, readFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { missingInlined, scanImportedDeps } from "./inline-check.ts";

/** Packages that MUST be embedded into the artifact (W0 spike, INV-D8). */
const DOCUMENTS_DEPS = ["fast-xml-parser", "pdfjs-dist"];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
};

const deps = Object.keys(pkg.dependencies ?? {});
const externals = deps.filter((name) => !DOCUMENTS_DEPS.includes(name));
const inlined = deps.filter((name) => DOCUMENTS_DEPS.includes(name));

// Coupling guard: every DOCUMENTS_DEPS name must be a real dependency, otherwise a
// typo/rename would silently make it external (no `--external`, so "inlined" never
// happens) instead of failing the build.
const missing = DOCUMENTS_DEPS.filter((name) => !deps.includes(name));
if (missing.length > 0) {
  process.stderr.write(
    `[build:documents] DOCUMENTS_DEPS missing from package.json dependencies: ${missing.join(", ")}\n`,
  );
  process.exit(1);
}

process.stdout.write(`[build:documents] inline: ${inlined.join(", ") || "(none)"}\n`);
process.stdout.write(`[build:documents] external: ${externals.join(", ")}\n`);

/** Bun's build metafile lands here; its `inputs` are the inlined module graph. */
const metaPath = join(root, "tmp", "build-documents-meta.json");

const args = [
  "build",
  join(root, "src/cli/main.ts"),
  "--outfile",
  join(root, "dist/main.js"),
  "--target",
  "node",
  "--format",
  "esm",
  `--metafile=${metaPath}`,
  ...externals.flatMap((name) => ["--external", name]),
];

await mkdir(dirname(metaPath), { recursive: true });
const proc = Bun.spawn(["bun", ...args], { stdio: ["inherit", "inherit", "inherit"] });
const code = await proc.exited;
if (code !== 0) {
  process.stderr.write(`[build:documents] bun build failed with exit code ${code}\n`);
  process.exit(code);
}

// Only deps `src/**` actually imports must be inlined; a dep whose handler is
// disabled is legitimately absent. An imported dep missing from the bundle's
// input graph means a silently-mis-built artifact — fail loudly.
const importedDeps = scanImportedDeps(join(root, "src"), DOCUMENTS_DEPS);
const meta = JSON.parse(await readFile(metaPath, "utf8"));
const notInlined = missingInlined(meta, importedDeps);
if (notInlined.length > 0) {
  process.stderr.write(
    `[build:documents] documents deps imported by src but NOT inlined into dist/main.js: ${notInlined.join(", ")}\n`,
  );
  process.exit(1);
}
process.stdout.write(`[build:documents] inline-check OK: ${importedDeps.join(", ") || "(none)"}\n`);
