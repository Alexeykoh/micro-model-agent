import type { IndexedFile } from "./walker";
import { toForwardSlash } from "../../tools/path-utils";

const CODE_LANGUAGES = new Set([
  "typescript",
  "typescript-react",
  "javascript",
  "javascript-react",
  "python",
  "rust",
  "go",
]);

/** Lockfiles and generated manifests: no structural value in the map. */
const NOISE_BASENAMES = new Set([
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "yarn.lock",
  "pnpm-lock.yaml",
  "cargo.lock",
  "go.sum",
  "composer.lock",
  "poetry.lock",
]);

export function isNoiseFile(file: IndexedFile): boolean {
  const base = toForwardSlash(file.path).split("/").pop()?.toLowerCase() ?? "";
  return NOISE_BASENAMES.has(base);
}

function isTestFile(path: string): boolean {
  return (
    path.startsWith("test/") ||
    path.startsWith("tests/") ||
    path.includes("/test/") ||
    path.includes("/tests/") ||
    path.includes("__tests__/") ||
    /\.(test|spec)\.[a-z0-9]+$/i.test(path)
  );
}

/** Lower rank = more useful for understanding the project structure. */
function rank(file: IndexedFile): number {
  const path = toForwardSlash(file.path).toLowerCase();
  if (isTestFile(path)) return 1;
  if (CODE_LANGUAGES.has(file.language)) return 0;
  return 2;
}

/** Top-level segment of a path (`src/core/x.ts` → `src`; root file → its name). */
function topDir(path: string): string {
  const normalized = toForwardSlash(path);
  const slash = normalized.indexOf("/");
  return slash >= 0 ? normalized.slice(0, slash) : normalized;
}

/** How many source-code files live under each top-level directory. */
function codeCountByTopDir(files: IndexedFile[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    if (isNoiseFile(file) || rank(file) !== 0) continue;
    const dir = topDir(file.path);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return counts;
}

/**
 * Pick the files to list in the project-map prompt block.
 *
 * The index is built by an arbitrary `readdir` walk, so a naive
 * `files.slice(0, N)` can end up listing only docs, config and tests while the
 * actual source tree (`src/`) never appears — the model then sees a "project
 * map" with no code in it. The selection:
 *   1. drops lockfile noise,
 *   2. ranks source before tests, tests before docs/config,
 *   3. within a rank, puts directories with the most source files first (the
 *      densest code root is almost always the real source tree — no directory
 *      names hardcoded),
 *   4. then shallower paths, then alphabetical — deterministic so the block
 *      does not change between turns and the prefix KV-cache survives.
 */
export function selectMapFiles(files: IndexedFile[], max: number): IndexedFile[] {
  const codeByDir = codeCountByTopDir(files);
  return files
    .filter((file) => !isNoiseFile(file))
    .sort((a, b) => {
      const rankDiff = rank(a) - rank(b);
      if (rankDiff !== 0) return rankDiff;
      const densityDiff =
        (codeByDir.get(topDir(b.path)) ?? 0) - (codeByDir.get(topDir(a.path)) ?? 0);
      if (densityDiff !== 0) return densityDiff;
      const pathA = toForwardSlash(a.path);
      const pathB = toForwardSlash(b.path);
      const depthDiff = pathA.split("/").length - pathB.split("/").length;
      if (depthDiff !== 0) return depthDiff;
      return pathA < pathB ? -1 : pathA > pathB ? 1 : 0;
    })
    .slice(0, max);
}
