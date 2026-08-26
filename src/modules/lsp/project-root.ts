import { existsSync } from "fs";
import { dirname, join, relative, isAbsolute } from "path";

/**
 * Resolve the LSP workspace root for an edited file.
 *
 * The workspace root must be the nearest project of the *edited file*, not the
 * agent baseDir — tsserver resolves `typescript` relative to the workspace
 * root, so for a file in `bicycle-shop/src/x.ts` under baseDir `mma_tests` the
 * root must be `bicycle-shop` (observed: "Could not find a valid TypeScript
 * installation" on every write/edit because baseDir had no node_modules).
 *
 * Which files mark a project root is language-specific and is declared in the
 * LSP server config (`LspServerConfig.workspaceMarkers`) — this function takes
 * the markers as a parameter and performs no language detection itself.
 */
export function findProjectRoot(filePath: string, baseDir: string, markers: string[]): string {
  if (!markers || markers.length === 0) return baseDir;
  let dir = dirname(filePath);
  const root = baseDir.replace(/[\\/]+$/, "");
  // Clamp the walk to baseDir: callers that pass baseDir itself as filePath
  // (probes) start at dirname(baseDir) — ABOVE the sandbox — and would pick up
  // a marker directory from the parent (e.g. a package.json next to it).
  const rel = relative(root, dir);
  if ((rel && rel.startsWith("..")) || isAbsolute(rel)) dir = root;
  while (true) {
    if (markers.some((m) => existsSync(join(dir, m)))) {
      return dir;
    }
    if (dir === root) return dir;
    const parent = dirname(dir);
    if (parent === dir) return root;
    dir = parent;
  }
}
