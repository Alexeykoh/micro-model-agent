import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";

/**
 * Read the bundled CHANGELOG.md from the installed npm package.
 * Resolves relative to this file's location (dist/modules/updater/) going up
 * to the package root.
 */
export function readChangelog(packageName: string): string | null {
  try {
    // Walk up from this file to find package.json
    let dir = dirname(import.meta.url);
    // Convert file:// URL to path on POSIX, or just use the path directly
    if (dir.startsWith("file://")) {
      dir = decodeURIComponent(dir.slice(7));
    }
    // Find package root (contains package.json with matching name)
    for (let i = 0; i < 10; i++) {
      const pkgPath = join(dir, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.name === packageName) {
          const changelogPath = join(dir, "CHANGELOG.md");
          if (existsSync(changelogPath)) {
            return readFileSync(changelogPath, "utf-8");
          }
          return null;
        }
      }
      dir = dirname(dir);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract changelog entries between two versions (exclusive old, inclusive new).
 * Returns the raw markdown sections.
 *
 * parseChangelog(changelog, "0.55.1", "0.56.1") =>
 *   "## [0.56.1] - ...\n...\n## [0.56.0] - ...\n..."
 */
export function extractChangelogRange(
  changelog: string,
  fromVersion: string,
  toVersion: string,
): string | null {
  const lines = changelog.split("\n");
  const sections: string[] = [];
  let capturing = false;
  let foundFrom = false;

  for (const line of lines) {
    const match = line.match(/^## \[(\d+\.\d+\.\d+)\]/);
    if (match) {
      const ver = match[1];
      if (ver === fromVersion) {
        // Stop before this section (exclusive).
        foundFrom = true;
        break;
      }
      if (capturing) {
        // New section header — separate with blank line.
        sections.push("");
      }
      capturing = true;
    }
    if (capturing) {
      sections.push(line);
    }
  }

  // If the "from" version was never found, return null (no valid range).
  if (!foundFrom) return null;
  return sections.length > 0 ? sections.join("\n").trim() : null;
}

/**
 * Get the latest changelog entry (most recent version).
 */
export function extractLatestChangelog(changelog: string): string | null {
  const lines = changelog.split("\n");
  const sections: string[] = [];
  let capturing = false;
  let found = false;

  for (const line of lines) {
    const match = line.match(/^## \[(\d+\.\d+\.\d+)\]/);
    if (match) {
      if (found) break; // Stop at second section header.
      capturing = true;
      found = true;
    }
    if (capturing) {
      sections.push(line);
    }
  }

  return sections.length > 0 ? sections.join("\n").trim() : null;
}
