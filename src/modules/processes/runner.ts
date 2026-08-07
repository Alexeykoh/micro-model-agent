/**
 * Kill callbacks registered by long-running tool handlers so the tool executor
 * can abort/kill them on timeout or user interrupt. Process spawning itself
 * lives in `registry.ts` — `runCommand` was removed in favor of behavior-based
 * background promotion (see `src/tools/bash.ts`).
 */
interface ActiveChild {
  kill: () => void;
}

const activeChildren = new Map<string, ActiveChild>();

/** Register a kill callback for a tool call id (executor timeout/abort). */
export function registerKillable(callId: string, kill: () => void): void {
  activeChildren.set(callId, { kill });
}

/** Unregister a tool call's kill callback once its handler finished. */
export function unregisterKillable(callId: string): void {
  activeChildren.delete(callId);
}

/** Invoke (and drop) the kill callback registered for `callId`. */
export function killByCallId(callId: string): boolean {
  const entry = activeChildren.get(callId);
  if (!entry) return false;
  activeChildren.delete(callId);
  try {
    entry.kill();
  } catch {
    /* already dead */
  }
  return true;
}
