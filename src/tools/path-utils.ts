import { resolve, normalize, dirname, basename, sep } from 'path'
import { existsSync } from 'fs'

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
  const norm = normalize(userPath)
  const stripped = norm.replace(/^[/\\]/, '')
  const resolved = resolve(baseDir, stripped)

  // Fast path: if it exists (or parent does for new files), return it
  if (existsSync(resolved) || existsSync(dirname(resolved))) return resolved

  const baseNorm = normalize(baseDir)

  // Walk ancestors and look for missing separators
  let cur = baseNorm
  while (cur && cur !== dirname(cur)) {
    const name = basename(cur)
    if (!name) { cur = dirname(cur); continue }

    let idx = stripped.toLowerCase().indexOf(name.toLowerCase())
    while (idx >= 0) {
      const afterIdx = idx + name.length
      const afterChar = stripped[afterIdx]

      if (afterChar && afterChar !== '\\' && afterChar !== '/') {
        const fixed = stripped.slice(0, afterIdx) + sep + stripped.slice(afterIdx)
        const fixedResolved = resolve(baseDir, normalize(fixed))
        if (existsSync(fixedResolved) || existsSync(dirname(fixedResolved))) {
          return fixedResolved
        }
        // Try from ancestor's parent
        const fromParent = resolve(dirname(cur), normalize(fixed))
        if (existsSync(fromParent) || existsSync(dirname(fromParent))) {
          return fromParent
        }
      }

      idx = stripped.toLowerCase().indexOf(name.toLowerCase(), idx + 1)
    }

    cur = dirname(cur)
  }

  return resolved
}
