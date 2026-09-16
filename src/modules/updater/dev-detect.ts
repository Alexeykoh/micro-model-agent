/**
 * True when the running entry is a TypeScript source file — i.e. a dev run
 * (`bun run src/cli/main.ts`, `bun --watch src/cli/main.ts`, tsx/ts-node).
 * The published package is loaded as bundled `dist/main.js` via `bin/mma.mjs`,
 * so this is false for real installs.
 *
 * Dev runs MUST NOT self-update: a checkout's package.json version can
 * legitimately trail npm, and silently `npm install -g`-ing over the user's
 * global install from a dev working tree is destructive and surprising.
 */
export function isDevEntryPath(path: string): boolean {
  const clean = path.split(/[?#]/)[0];
  return (
    clean.endsWith(".ts") ||
    clean.endsWith(".tsx") ||
    clean.endsWith(".mts") ||
    clean.endsWith(".cts")
  );
}
