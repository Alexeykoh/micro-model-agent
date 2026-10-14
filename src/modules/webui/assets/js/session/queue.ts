// Pinned input-queue strip + drain for `mma web`.
//
// A message sent while a session's turn is running is queued server-side
// (`202 {queued: n}`) and runs after the current turn. Injecting it into the
// feed right away landed it in the middle of the live answer and then scrolled
// away; instead it is pinned above the composer until its turn actually starts,
// when `drainQueuedTurn` appends it to the transcript in order.
import { el } from "../dom.js";
import { t } from "../i18n.js";
import { tabs as tabState, session } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { appendTo, userBlock } from "../feed.js";

/** A queued message: text plus already-downscaled attachment data-URLs. */
export interface PendingMessage {
  text: string;
  images: string[];
}

/** The active session tab (same projection `tabs.ts` exposes as `activeTab`). */
function activeTab(): Dict | null {
  return tabState.tabs.find((x) => x.id === tabState.activeTabId) || null;
}

/** Local mirror of a tab's server-side input queue (text for the receipt). */
function pendingQueue(tab: Dict | null): PendingMessage[] {
  if (!tab) return [];
  if (!Array.isArray(tab.pendingQueue)) tab.pendingQueue = [];
  return tab.pendingQueue as PendingMessage[];
}

/** Records a just-queued message on its tab (called after `202 {queued}`). */
export function enqueuePending(tab: Dict | null, msg: PendingMessage): void {
  if (!tab) return;
  pendingQueue(tab).push(msg);
}

const strip = document.getElementById("queueStrip");

/**
 * Renders the pinned queue strip for the active tab: one row per pending
 * message, with a placeholder for entries the server reports but this client
 * has no text for (another tab, or a reload mid-turn).
 */
export function renderQueueStrip(): void {
  if (!strip) return;
  const tab = activeTab();
  const items = pendingQueue(tab);
  const serverCount = tab && tab.kind === "session" ? session.queued[tab.id] || 0 : 0;
  const total = Math.max(items.length, serverCount);
  if (total === 0) {
    strip.hidden = true;
    strip.replaceChildren();
    return;
  }
  const rows: HTMLElement[] = [];
  for (let i = 0; i < total; i++) {
    const item = items[i];
    const row = el("div", "queue-item");
    row.appendChild(el("span", "qi-g", "↳"));
    row.appendChild(el("span", "qi-text", item ? item.text : t("web.queue.unknown")));
    row.appendChild(el("span", "qi-pos", t("web.input.queued", { n: i + 1 })));
    rows.push(row);
  }
  strip.replaceChildren(...rows);
  strip.hidden = false;
}

/**
 * Moves the head of a session's local queue into its transcript. Called on
 * `turn_end`: the finished turn frees the slot and the next queued message
 * starts, so its user block belongs here — before the new turn streams.
 */
export function drainQueuedTurn(sessionId?: string | null): void {
  if (!sessionId) return;
  const tab = tabState.tabs.find((x) => x.id === sessionId);
  if (!tab) return;
  const head = pendingQueue(tab).shift();
  if (head) appendTo(tab.feed, userBlock(head.text, head.images));
  renderQueueStrip();
}
