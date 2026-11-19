// Verification for `scripts/build-documents.ts`: after `bun build --metafile`
// writes the input graph, confirm every documents dependency actually imported by
// `src/**` is present in the packaged artifact. A dep the code imports but that
// was left external is a silently-mis-built bundle — it must fail loudly instead
// of shipping broken. Pays the registry debt `documents-inline-unverified` (rule 9):
// docs/agents/debt.md, docs/specs/2026-10-16-documents-module-design.md §4.6.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Input module paths recorded in a Bun build metafile. */
function inputPaths(metaJson: unknown): string[] {
  if (typeof metaJson !== "object" || metaJson === null) return [];
  const inputs = (metaJson as { inputs?: unknown }).inputs;
  if (typeof inputs !== "object" || inputs === null) return [];
  return Object.keys(inputs);
}

/**
 * Deps from `srcImportedDeps` that have **no** input path under
 * `node_modules/<dep>/` in the metafile — i.e. were not inlined into the
 * artifact. Pure and testable; `metaJson` is whatever `--metafile` produced.
 */
export function missingInlined(metaJson: unknown, srcImportedDeps: string[]): string[] {
  const paths = inputPaths(metaJson).map((p) => p.replace(/\\/g, "/"));
  return srcImportedDeps.filter((dep) => !paths.some((p) => p.includes(`node_modules/${dep}/`)));
}

/** Strips comments so a mention inside one is not read as an import. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n\r]*/g, "$1");
}

/**
 * Module specifiers imported by a source text: static imports and re-exports
 * (keyword `from` followed by a quoted module), dynamic `import(…)` and bare
 * side-effect imports.
 */
export function importedSpecifiers(text: string): string[] {
  const src = stripComments(text);
  const out: string[] = [];
  const re = /(?:\bfrom\s*|import\s*\(\s*|import\s*)["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

/**
 * Documents deps (from `depNames`) that `src/**` actually imports — a specifier
 * equal to the name or starting with `<name>/`. A dep whose handler is disabled
 * is legitimately not scanned (nothing to find), so it must not be required in
 * the bundle.
 */
export function scanImportedDeps(srcRoot: string, depNames: string[]): string[] {
  const specs = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".ts")) {
        for (const spec of importedSpecifiers(readFileSync(full, "utf-8"))) specs.add(spec);
      }
    }
  };
  walk(srcRoot);
  return depNames.filter((dep) => [...specs].some((s) => s === dep || s.startsWith(`${dep}/`)));
}
