import { existsSync } from 'fs'

/**
 * Pick the first existing candidate path, falling back to the first candidate.
 * Split out of bridge-client.ts so the source-vs-dist layout resolution is
 * unit-testable without spawning a node bridge (rule #12: build-time values
 * are resolved from disk at runtime, never inlined).
 */
export function pickExistingPath(
  candidates: string[],
  fallback = candidates[0],
): string {
  return candidates.find((p) => existsSync(p)) ?? fallback
}
