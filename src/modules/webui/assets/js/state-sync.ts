// Pure routing of `state`/`usage` payloads into the per-tab store slices.
// No DOM: this module is the testable core behind `app.ts`'s renderers.
import { tabs as tabState, session } from "./store.js";
import type { Dict } from "./core/store/types.js";

/** Copies run/queue counters from a `state` payload into the session slice. */
export function applyCounters(d: Dict): void {
  session.busy = !!d.busy;
  session.runningSessionId = d.runningSessionId || null;
  session.runningSessionIds =
    d.runningSessionIds || (session.runningSessionId ? [session.runningSessionId] : []);
  session.queued = d.queued || {};
  session.queuedIds = d.queuedIds || {};
}

/**
 * Routes a `state` payload into the per-tab store. Returns true when the active
 * tab must re-render (payload has no session or targets the active tab).
 */
export function routeState(d: Dict): boolean {
  applyCounters(d);
  const active = tabState.activeTabId;
  if (d.state) {
    const target = typeof d.sessionId === "string" ? d.sessionId : active;
    const tab = target ? tabState.tabs.find((x) => x.id === target) : null;
    if (tab) tab.state = d.state;
  }
  return !d.sessionId || d.sessionId === active;
}

/** Stores a snapshot fetched over REST on its open tab; returns its session id. */
export function storeSnapshot(snapshot: Dict | null | undefined): string | null {
  const sid = snapshot && snapshot.sessionId;
  if (typeof sid !== "string") return null;
  const tab = tabState.tabs.find((x) => x.id === sid);
  if (tab) tab.state = snapshot;
  return sid;
}

/**
 * Whether an auto-opened (server-active) session should fetch its transcript.
 * An existing session with messages must hydrate its history; opening it as a
 * "live" tab left the feed empty (missing first message and earlier turns) until
 * new SSE. A brand-new session has nothing to fetch and stays live.
 */
export function shouldHydrateAutoOpen(
  sessions: Dict[] | null | undefined,
  sessionId: string | null | undefined,
): boolean {
  if (!sessionId) return false;
  const meta = (sessions || []).find((s) => s.id === sessionId);
  return !!(meta && typeof meta.messageCount === "number" && meta.messageCount > 0);
}

/**
 * Merges a partial `usage` payload into the owner tab's snapshot. Returns true
 * when the active tab was affected (caller re-renders the usage bar).
 */
export function mergeUsage(owner: string | null, usage: Dict): boolean {
  const tab = owner ? tabState.tabs.find((x) => x.id === owner) : null;
  if (tab) tab.state = Object.assign({}, tab.state, usage);
  const active = !owner || owner === tabState.activeTabId;
  if (active) session.host = Object.assign({}, session.host, usage);
  return active;
}
