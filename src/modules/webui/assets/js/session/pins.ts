// Pinned sessions for the dropdown (U14). A browser-local preference: no
// server contract, no cross-device sync - just "keep this one at the top".
export const PIN_KEY = "mma-pinned-sessions";
export const PRUNE_NOTICE_AT = 60;

/** Ids currently pinned. Tolerates private mode and corrupt JSON. */
export function pinnedSessionIds(): Set<string> {
  try {
    const raw = localStorage.getItem(PIN_KEY);
    const arr: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function isSessionPinned(id: string): boolean {
  return pinnedSessionIds().has(id);
}

/** Flips the pin, persists it and returns the new state. No rendering. */
export function toggleSessionPin(id: string): boolean {
  const set = pinnedSessionIds();
  const on = !set.has(id);
  if (on) set.add(id);
  else set.delete(id);
  try {
    localStorage.setItem(PIN_KEY, JSON.stringify([...set]));
  } catch {
    /* private mode */
  }
  return on;
}
