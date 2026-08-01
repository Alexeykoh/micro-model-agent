/**
 * Heuristic detection of long-running (server/watch) commands.
 *
 * The explicit `background: true` bash parameter always wins; this list is a
 * convenience so dev servers don't block the agent. It only inspects the raw
 * shell command (a technical process-type decision, not task classification).
 */
const LONG_RUNNING_PATTERNS: RegExp[] = [
  /\b(npm|pnpm|yarn|bun|npx)\s+(run\s+)?(dev|start|serve|preview|watch|server)\b/i,
  /\b(deno|node)\s+.*\b(run\s+)?(dev|serve|watch|server)\b/i,
  /(^|\s)--watch\b/i,
  /(^|\s)-w\b/i,
  /\bnodemon\b/i,
  /\btsx watch\b/i,
  /\b(ts-node|tsc)\s+.*--watch\b/i,
  /\bvite(?!\s+(build|create))\b/i,
  /\bwebpack(-dev-server|\s+serve)\b/i,
  /\bastro dev\b/i,
  /\bnext (dev|start)\b/i,
  /\bnuxt (dev|start)\b/i,
  /\bsvelte-kit (dev|preview)\b/i,
  /\bgatsby develop\b/i,
  /\bdocker(-compose)?\s+.*\bup\b/i,
  /\buvicorn\b|\bgunicorn\b/i,
  /\bpython\s+-m\s+http\.server\b/i,
  /\bflask run\b/i,
  /\bphp artisan serve\b/i,
  /\brails (server|s)\b/i,
  /\bvitest watch\b/i,
  /\bjest --watch\b/i,
];

export function isLongRunningCommand(command: string): boolean {
  return LONG_RUNNING_PATTERNS.some((pattern) => pattern.test(command));
}
