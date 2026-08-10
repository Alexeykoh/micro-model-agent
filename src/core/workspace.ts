import { existsSync, readdirSync } from "fs";
import { resolve, isAbsolute, join } from "path";

/** Files/dirs that mark a directory as a project root. */
const PROJECT_MANIFESTS = [
  "package.json",
  "bun.lockb",
  "bun.lock",
  "yarn.lock",
  "pnpm-lock.yaml",
  "go.mod",
  "Cargo.toml",
  "pyproject.toml",
  "requirements.txt",
  "Gemfile",
  "composer.json",
];

/** Immediate subdirectories that are never candidate project roots. */
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".hg", ".svn"]);

const subdirCache = new Map<string, string[]>();

function scanSubdirs(baseDir: string): string[] {
  const cached = subdirCache.get(baseDir);
  if (cached) return cached;
  let dirs: string[] = [];
  try {
    dirs = readdirSync(baseDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .filter((name) => !SKIP_DIRS.has(name));
  } catch {
    dirs = [];
  }
  if (dirs.length > 0) subdirCache.set(baseDir, dirs);
  return dirs;
}

export function hasProjectManifest(dir: string): boolean {
  return PROJECT_MANIFESTS.some((m) => existsSync(join(dir, m)));
}

/**
 * Resolve a file/dir path inside a workspace, tolerating the common case
 * where the agent runs from a parent directory while the actual project
 * lives in a single immediate subdirectory (e.g. baseDir=<repo>,
 * project=<repo>/app). Resolution order:
 *   1. absolute path as-is;
 *   2. baseDir/<p> тАФ project rooted directly at baseDir;
 *   3. <subdir>/<p> for each immediate project subdirectory of baseDir
 *      (manifest-bearing subdirectories are preferred).
 * Returns baseDir/<p> as a fallback when nothing exists, so callers that
 * check existsSync() still correctly report the path as missing.
 */
export function resolveProjectPath(baseDir: string, p: string): string {
  const abs = isAbsolute(p) ? p : resolve(baseDir, p);
  if (existsSync(abs)) return abs;

  // baseDir itself is a project root тАФ paths are relative to it. Probing
  // subdirectories here would match files in unrelated nested packages.
  if (hasProjectManifest(baseDir)) return abs;

  let fallback = abs;
  for (const name of scanSubdirs(baseDir)) {
    const candidate = resolve(baseDir, name, p);
    if (existsSync(candidate)) {
      if (hasProjectManifest(join(baseDir, name))) return candidate;
      if (fallback === abs) fallback = candidate;
    }
  }
  return fallback;
}

/** Clear the internal subdirectory cache (used by tests). */
export function clearWorkspaceCache(): void {
  subdirCache.clear();
}
