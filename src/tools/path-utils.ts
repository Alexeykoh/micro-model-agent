import { resolve, normalize, dirname, basename, sep, relative, isAbsolute } from "path";
import { existsSync } from "fs";

/**
 * Normalize backslashes to forward slashes for display and comparison.
 * On POSIX this is a no-op; on Windows it converts `src\foo\bar.ts` → `src/foo/bar.ts`.
 */
export function toForwardSlash(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * True when targetPath equals dirPath or lies inside it.
 *
 * Cross-platform notes:
 * - Uses path.relative() instead of raw startsWith, so a sibling directory
 *   sharing the string prefix ("src" vs "src-other") can never pass.
 * - On Windows the filesystem is case-insensitive: both sides are lowercased
 *   before comparison so "E:\Proj" and "e:\proj" resolve to the same dir.
 */
export function isInsideDir(targetPath: string, dirPath: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const t = norm(resolve(targetPath));
  const d = norm(resolve(dirPath));
  if (t === d) return true;
  const rel = relative(d, t);
  return rel.length > 0 && !isAbsolute(rel) && !rel.startsWith("..");
}

/**
 * True when targetPath matches a scope entry: either the entry file itself or
 * anything inside the entry directory. Separator- and case-safe (see
 * isInsideDir).
 */
export function matchesScopeEntry(targetResolved: string, entryResolved: string): boolean {
  if (targetResolved === entryResolved) return true;
  return isInsideDir(targetResolved, entryResolved);
}

/**
 * Resolve a user-provided path against baseDir.
 *
 * Handles common model mistakes:
 * 1. Leading slash: "/testing/cat3" → resolve relative to baseDir
 * 2. Missing separator: "E:\agent_test" when baseDir is "E:\agent\_test"
 *    → inserts the missing backslash
 *
 * For new files the parent directory must exist; we check that instead of
 * the full path so write_file still works.
 */
export function safeResolvePath(baseDir: string, userPath: string): string {
  // Absolute path that actually exists — honor it as-is
  const asIs = resolve(normalize(userPath));
  if (userPath.startsWith("/") || userPath.startsWith("\\")) {
    if (existsSync(asIs) || existsSync(dirname(asIs))) return asIs;
  }

  const norm = normalize(userPath);

  // Absolute paths are used verbatim — do NOT strip a leading slash and
  // re-resolve against baseDir (that would turn /var/folders/... into
  // baseDir/var/folders/... on POSIX). The leading-slash heuristic below
  // only applies as a fallback when the absolute path does not resolve.
  if (isAbsolute(norm)) {
    if (existsSync(norm) || existsSync(dirname(norm))) return norm;
    // Absolute but not on disk yet (e.g. a new file whose dirs don't exist).
    // Model mistake recovery: a leading slash may mean "relative to baseDir".
    const stripped = norm.replace(/^[/\\]/, "");
    const relativeCandidate = resolve(baseDir, stripped);
    if (existsSync(relativeCandidate) || existsSync(dirname(relativeCandidate))) {
      return relativeCandidate;
    }
    return norm;
  }

  const stripped = norm.replace(/^[/\\]/, "");
  const resolved = resolve(baseDir, stripped);

  // Fast path: if it exists (or parent does for new files), return it
  if (existsSync(resolved) || existsSync(dirname(resolved))) return resolved;

  const baseNorm = normalize(baseDir);

  // Walk ancestors and look for missing separators
  let cur = baseNorm;
  while (cur && cur !== dirname(cur)) {
    const name = basename(cur);
    if (!name) {
      cur = dirname(cur);
      continue;
    }

    let idx = stripped.toLowerCase().indexOf(name.toLowerCase());
    while (idx >= 0) {
      const afterIdx = idx + name.length;
      const afterChar = stripped[afterIdx];

      if (afterChar && afterChar !== "\\" && afterChar !== "/") {
        const fixed = stripped.slice(0, afterIdx) + sep + stripped.slice(afterIdx);
        const fixedResolved = resolve(baseDir, normalize(fixed));
        if (existsSync(fixedResolved) || existsSync(dirname(fixedResolved))) {
          return fixedResolved;
        }
        // Try from ancestor's parent
        const fromParent = resolve(dirname(cur), normalize(fixed));
        if (existsSync(fromParent) || existsSync(dirname(fromParent))) {
          return fromParent;
        }
      }

      idx = stripped.toLowerCase().indexOf(name.toLowerCase(), idx + 1);
    }

    cur = dirname(cur);
  }

  return resolved;
}
