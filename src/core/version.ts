import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

/**
 * Read the MMA version from package.json at runtime (never a static import —
 * bundlers inline a stale value at build time, see design rule #12).
 */
export function readMmaVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "..", "..", "package.json"), join(here, "..", "package.json")];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const raw = JSON.parse(readFileSync(p, "utf8"));
        if (raw.version) return raw.version;
      } catch {
        // Broken package.json — fall through to the next candidate
      }
    }
  }
  return "0.0.0";
}

/** Legacy alias — use readMmaVersion(). */
export const readVersion = readMmaVersion;
