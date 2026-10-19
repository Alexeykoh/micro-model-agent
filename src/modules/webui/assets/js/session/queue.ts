// Pinned input-queue strip + drain for `mma web`.
//
// A message sent while a session's turn is running is queued server-side
// (`202 {queued: n, id}`) and runs after the current turn. Injecting it into the
// feed right away landed it in the middle of the live answer and then scrolled
// away; instead it is pinned above the composer until its turn actually starts,
// when `drainQueuedTurn` appends it to the transcript in order.
//
// Every row carries the server message id, so it can be cancelled or started
// now without relying on a queue position that may shift under the click.
import { el } from "../dom.js";
import { t } from "../i18n.js";
import { tabs as tabState, session } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { appendTo, userBlock } from "../feed.js";
import { api } from "../api.js";
import { setIndicator } from "../dialog.js";

/** A queued message: text plus already-downscaled attachment data-URLs. */
export interface PendingMessage {
  /** Server id (`qN`); absent only for legacy/local-only entries. */
  id?: string;
  text: string;
  images: string[];
}

/** One rendered row: a server id and, when this client knows it, the message. */
interface QueueRow {
  id: string;
  item?: PendingMessage;
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

/** Removes a local pending message by server id; false — unknown id. */
export function removePending(tab: Dict | null, id: string): boolean {
  if (!tab || !id) return false;
  const queue = pendingQueue(tab);
  const i = queue.findIndex((m) => m.id === id);
  if (i === -1) return false;
  queue.splice(i, 1);
  return true;
}

/** Moves a local pending message to the head; false — unknown id. */
export function promotePending(tab: Dict | null, id: string): boolean {
  if (!tab || !id) return false;
  const queue = pendingQueue(tab);
  const i = queue.findIndex((m) => m.id === id);
  if (i === -1) return false;
  const [message] = queue.splice(i, 1);
  queue.unshift(message);
  return true;
}

/** Server ids for the tab's session (id-less tests/legacy fall back to local). */
function serverIds(tab: Dict): string[] {
  const key = String(tab.id ?? "");
  const ids = key ? session.queuedIds[key] : undefined;
  return Array.isArray(ids) ? ids : [];
}

/** Sets the local projection of the server queue (keeps the strip in sync). */
function setServerIds(tab: Dict, ids: string[]): void {
  const key = String(tab.id ?? "");
  if (!key) return;
  session.queuedIds[key] = ids;
}

/** Drops a server id after a successful cancel (the confirming state follows). */
function dropServerId(tab: Dict, id: string): void {
  setServerIds(
    tab,
    serverIds(tab).filter((x) => x !== id),
  );
}

/** Moves a server id to the head after a successful start. */
function promoteServerId(tab: Dict, id: string): void {
  const ids = serverIds(tab);
  if (!ids.includes(id)) return;
  setServerIds(tab, [id, ...ids.filter((x) => x !== id)]);
}

/**
 * Builds rows from the server FIFO and local text. Server ids handle entries
 * this client has no text for (another tab, reload mid-turn); unknown local
 * entries are appended so a state lag never hides a just-queued message.
 */
function buildRows(tab: Dict): QueueRow[] {
  const items = pendingQueue(tab);
  const byId = new Map<string, PendingMessage>();
  for (const item of items) {
    if (item.id) byId.set(item.id, item);
  }
  const ids = serverIds(tab);
  const used = new Set<string>();
  const rows: QueueRow[] = [];
  for (const id of ids) {
    rows.push({ id, item: byId.get(id) });
    used.add(id);
  }
  for (const item of items) {
    if (!item.id) {
      rows.push({ id: "", item });
      continue;
    }
    if (!used.has(item.id)) rows.push({ id: item.id, item });
  }
  // Older state payloads carried only the count. Keep placeholders for entries
  // we cannot address, but prefer the id-bearing projection whenever present.
  const count = Number(session.queued[String(tab.id ?? "")] || 0);
  while (rows.length < count) rows.push({ id: "" });
  return rows;
}

/** Queue action endpoint suffix: cancel removes, start interrupts + promotes. */
type QueueAction = "cancel" | "start";

function actionButton(kind: QueueAction, tab: Dict, id: string): HTMLButtonElement {
  const label = t(kind === "start" ? "web.queue.run_now" : "web.queue.cancel");
  const cls = kind === "start" ? "qi-run" : "qi-cancel";
  const btn = el("button", `qi-btn ${cls}`, kind === "start" ? "▶" : "×") as HTMLButtonElement;
  btn.type = "button";
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    void runAction(kind, tab, id);
  });
  return btn;
}

/** Sends the action and applies its local effect before the SSE confirmation. */
async function runAction(kind: QueueAction, tab: Dict, id: string): Promise<void> {
  const r = await api<Dict>(`/api/queue/${kind}`, {
    method: "POST",
    body: { sessionId: tab.id, id },
  });
  if (!r.ok) {
    setIndicator(t(kind === "cancel" ? "web.queue.cancel_failed" : "web.queue.start_failed"), true);
    return;
  }
  if (kind === "cancel") {
    removePending(tab, id);
    dropServerId(tab, id);
    const key = String(tab.id ?? "");
    if (key && session.queued[key]) {
      session.queued[key] -= 1;
      if (session.queued[key] <= 0) delete session.queued[key];
    }
  } else if (r.data?.started === true) {
    // Race with a natural turn_end: the server already started the turn, so
    // there is no prior `turn_end` left to drain this row into the feed.
    const queue = pendingQueue(tab);
    const i = queue.findIndex((m) => m.id === id);
    const item = i === -1 ? undefined : queue.splice(i, 1)[0];
    dropServerId(tab, id);
    if (item) appendTo(tab.feed, userBlock(item.text, item.images));
  } else {
    promotePending(tab, id);
    promoteServerId(tab, id);
  }
  renderQueueStrip();
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
  if (!tab) {
    strip.hidden = true;
    strip.replaceChildren();
    return;
  }
  const rows = buildRows(tab);
  if (rows.length === 0) {
    strip.hidden = true;
    strip.replaceChildren();
    return;
  }
  const nodes: HTMLElement[] = [];
  rows.forEach((row, i) => {
    const line = el("div", "queue-item");
    line.appendChild(el("span", "qi-g", "↳"));
    line.appendChild(el("span", "qi-text", row.item ? row.item.text : t("web.queue.unknown")));
    if (row.id) {
      const actions = el("span", "qi-actions");
      actions.append(actionButton("start", tab, row.id), actionButton("cancel", tab, row.id));
      line.appendChild(actions);
    }
    line.appendChild(el("span", "qi-pos", t("web.input.queued", { n: i + 1 })));
    nodes.push(line);
  });
  strip.replaceChildren(...nodes);
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
  const queue = pendingQueue(tab);
  const headId = serverIds(tab)[0];
  let head: PendingMessage | undefined;
  if (headId) {
    const i = queue.findIndex((m) => m.id === headId);
    if (i !== -1) head = queue.splice(i, 1)[0];
    dropServerId(tab, headId);
  } else {
    head = queue.shift();
  }
  if (head) appendTo(tab.feed, userBlock(head.text, head.images));
  renderQueueStrip();
}
