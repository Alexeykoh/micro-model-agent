// Collapsible agent-step groups for the web feed. Steps are hidden the moment
// they appear: `appendTo` reports every new feed row via `hooks.afterFeedAppend`
// and this module moves it into the current group's hidden detail, refreshing
// the one-line summary in place. Clicking the summary reveals the real rows —
// no re-render, so timers, statuses and file cards survive.
import { el, icon, setIcon } from "../dom.js";
import { t, pluralCount } from "../i18n.js";
import { hooks, streamStateFor } from "../store.js";
import { collapseSteps, formatMs } from "../format.js";
import { activeFeed, scroll } from "./core.js";

type Kind = "failures" | "warnings" | "thoughts" | "reads" | "edits" | "commands" | "tools";

const ORDER: Kind[] = ["failures", "warnings", "thoughts", "reads", "edits", "commands", "tools"];
const KEYS: Record<Kind, string> = {
  failures: "web.group.failures",
  warnings: "web.group.warnings",
  thoughts: "web.group.thoughts",
  reads: "web.group.reads",
  edits: "web.group.edits",
  commands: "web.group.commands",
  tools: "web.turn.tools", // existing plural set; no duplicate keys
};
// Lucide icons from the shared inlined set (MIT), one per category. All use the
// same dim color — the icon shape, not hue, carries the meaning.
const ICONS: Record<Kind, string> = {
  failures: "circle-alert",
  warnings: "triangle-alert",
  thoughts: "bulb",
  reads: "eye",
  edits: "file-text",
  commands: "code",
  tools: "wrench",
};
// Subagent rows keep their live MMART slot outside a folded group. Retract and
// critic notices are user-facing blocks, not agent steps — both stay visible.
// `.metaln.status` is transient: `clearStatusLines()` removes it before the
// critic report arrives. Folding one leaves an empty "+" group behind.
const ACTIVITY =
  ".think:not(.retract-block):not(.critic-block), .act, .filerow, .linkline, " +
  ".cmdout, .metaln:not(.status), .errline, .warnline, .detail";
// Only real content splits a turn into separate groups. Failure/status rows
// belong to the same step run — otherwise every tool error starts a new
// summary instead of updating the current one.
const BOUNDARY =
  ".u, .md, .ans, .msg-actions, .startbanner, .metric, " +
  ".act[data-tool-call-id], .retract-block, .critic-block, .q, .qcustom";

interface GroupState {
  summary: HTMLElement;
  detail: HTMLElement;
}
const groups = new WeakMap<HTMLElement, GroupState>();

function isActivity(node: HTMLElement): boolean {
  return node.matches(ACTIVITY) && !node.dataset.toolCallId;
}

function emptyCounts(): Record<Kind, number> {
  return { failures: 0, warnings: 0, thoughts: 0, reads: 0, edits: 0, commands: 0, tools: 0 };
}

/** Neutral notes stay in the detail but are not counted as steps. */
function kindOf(node: HTMLElement): Kind | null {
  if (node.matches(".errline")) return "failures";
  if (node.matches(".warnline, .metaln.warn")) return "warnings";
  if (node.matches(".metaln, .detail")) return null;
  if (node.classList.contains("think")) return "thoughts";
  if (
    node.classList.contains("cmdout") ||
    node.classList.contains("execute") ||
    node.classList.contains("exe")
  )
    return "commands";
  // `categoryOf()` yields `mutate`/`execute`; `.act` keeps legacy `mut`/`exe`.
  if (node.classList.contains("mutate") || node.classList.contains("mut")) return "edits";
  if (node.classList.contains("recon")) return "reads";
  return "tools";
}

function durationOf(node: HTMLElement): number {
  const ok = node.querySelector(".ok, .st, .dur");
  const m = /(\d+(?:\.\d+)?)\s*(ms|s)\b/.exec(ok ? ok.textContent || "" : "");
  if (!m) return 0;
  const value = Number(m[1]);
  return m[2] === "s" ? value * 1000 : value;
}

/** Counts as icon + label parts, separated by the house `·` divider. */
function buildParts(counts: Record<Kind, number>): HTMLElement {
  const parts = el("span", "parts");
  ORDER.filter((k) => counts[k] > 0).forEach((k, i) => {
    if (i) parts.appendChild(document.createTextNode(" · "));
    const part = el("span", `part part-${k}`);
    part.appendChild(icon(ICONS[k]));
    part.appendChild(document.createTextNode(pluralCount(KEYS[k], counts[k])));
    parts.appendChild(part);
  });
  return parts;
}

function metaText(durMs: number): string {
  const dur = durMs > 0 ? formatMs(durMs) : "";
  return dur ? " · " + dur : "";
}

/** Build the one-line summary. Text parts shrink and ellipsize on narrow feeds. */
export function buildGroupSummary(counts: Record<Kind, number>, durMs: number): HTMLElement {
  const bar = el("button", "group-sum");
  bar.type = "button";
  bar.setAttribute("aria-expanded", "false");
  bar.setAttribute("aria-label", t("web.group.label"));

  const mark = el("span", "g");
  mark.appendChild(icon("plus"));
  bar.appendChild(mark);
  bar.appendChild(buildParts(counts));
  bar.appendChild(el("span", "meta", metaText(durMs)));

  const tog = el("span", "tog");
  tog.appendChild(icon("chevron-right"));
  tog.setAttribute("title", t("web.action.show"));
  bar.appendChild(tog);
  return bar;
}

function refresh(feed: HTMLElement, g: GroupState): void {
  const counts = emptyCounts();
  let dur = 0;
  for (const node of Array.from(g.detail.children) as HTMLElement[]) {
    const kind = kindOf(node);
    if (kind) counts[kind]++;
    dur += durationOf(node);
  }
  // Fallback for rows without a rendered duration (e.g. interrupted tools).
  if (!dur) dur = streamStateFor(feed).runDuration;
  const parts = g.summary.querySelector(".parts") as HTMLElement | null;
  if (parts) {
    const before = parts.textContent;
    const next = buildParts(counts);
    parts.replaceChildren(...Array.from(next.childNodes));
    // Quiet pulse only when the counts actually changed (not on every frame).
    if (parts.textContent !== before) {
      parts.classList.remove("bump");
      void parts.offsetWidth; // restart the animation
      parts.classList.add("bump");
    }
  }
  const meta = g.summary.querySelector(".meta");
  if (meta) meta.textContent = metaText(dur);
}

function newGroup(feed: HTMLElement, node: HTMLElement): GroupState {
  const summary = buildGroupSummary(emptyCounts(), 0);
  summary.classList.add("enter");
  summary.addEventListener("click", () => toggleGroup(summary));
  const detail = el("div", "group-detail hidden");
  const parent = node.parentNode as ParentNode;
  parent.insertBefore(summary, node);
  parent.insertBefore(detail, node);
  const g = { summary, detail };
  groups.set(feed, g);
  return g;
}

function groupNode(feed: HTMLElement, node: HTMLElement): void {
  if (!feed || !collapseSteps() || !isActivity(node)) return;
  // Guard against a row reaching us twice: once it lives in a detail it must
  // stay there, otherwise `newGroup` would nest a group inside that detail.
  const host = node.parentElement?.closest(".group-detail") as HTMLElement | null;
  if (host) {
    const owner = host.previousElementSibling;
    if (owner?.classList.contains("group-sum"))
      refresh(feed, { summary: owner as HTMLElement, detail: host });
    return;
  }
  let g = groups.get(feed);
  if (g) {
    if (!g.summary.isConnected) g = undefined;
    else {
      // Walk back over status/error rows to this group's detail. A real content
      // block (user message, answer, copy row) ends the run instead.
      let prev = node.previousElementSibling;
      let sameRun = false;
      while (prev) {
        if (prev === g.detail) {
          sameRun = true;
          break;
        }
        if (prev.matches(BOUNDARY)) break;
        prev = prev.previousElementSibling;
      }
      if (!sameRun) g = undefined;
    }
  }
  if (!g) g = newGroup(feed, node);
  g.detail.appendChild(node);
  refresh(feed, g);
  if (feed === activeFeed()) scroll();
}

/** Kept as the public name used by the stream cluster and DOM tests. */
export const trackNode = groupNode;

/** Lift groups that an earlier pass nested inside a detail back to the feed. */
function denest(feed: HTMLElement): void {
  const nested = Array.from(feed.querySelectorAll(".group-detail > .group-sum")) as HTMLElement[];
  for (const sum of nested) {
    const outer = sum.parentElement as HTMLElement;
    const detail = sum.nextElementSibling;
    if (outer.parentElement !== feed) continue;
    feed.insertBefore(sum, outer.nextSibling);
    if (detail?.classList.contains("group-detail")) feed.insertBefore(detail, sum.nextSibling);
  }
}

/** Restore real rows and drop summaries (e.g. when the option is turned off). */
function unfoldIn(feed: HTMLElement): void {
  for (const sum of Array.from(feed.querySelectorAll(".group-sum")) as HTMLElement[]) {
    const detail = sum.nextElementSibling;
    const parent = sum.parentNode;
    if (!parent) continue;
    if (detail?.classList.contains("group-detail")) {
      while (detail.firstChild) parent.insertBefore(detail.firstChild, sum);
      detail.remove();
    }
    sum.remove();
  }
  groups.delete(feed);
}

/** Re-apply the option to feeds that already have content. */
export function syncStepFolding(): void {
  for (const feed of Array.from(document.querySelectorAll(".feed")) as HTMLElement[]) {
    if (collapseSteps()) foldHistory(feed);
    else unfoldIn(feed);
  }
}

/** Close the current group on assistant text / turn end (summary stays). */
export function foldRun(feed?: HTMLElement | null): void {
  if (!feed || !collapseSteps()) return;
  groups.delete(feed);
  // Safety net for rows appended without going through `appendTo`.
  foldHistory(feed);
}

/** Fold consecutive activity rows (history replay or a sync pass). */
export function foldHistory(feed: HTMLElement): void {
  groups.delete(feed);
  denest(feed);
  if (!collapseSteps()) return;
  for (const child of Array.from(feed.children) as HTMLElement[]) {
    if (child.classList.contains("group-sum") || child.classList.contains("group-detail"))
      continue;
    if (isActivity(child)) groupNode(feed, child);
    else if (child.matches(BOUNDARY)) groups.delete(feed);
  }
}

/** Expand/collapse one group in place, mirroring the `.think-h` toggle. */
function toggleGroup(head: HTMLElement): void {
  const detail = head.nextElementSibling;
  if (!detail || !detail.classList.contains("group-detail")) return;
  const hidden = detail.classList.toggle("hidden");
  head.setAttribute("aria-expanded", hidden ? "false" : "true");
  const tog = head.querySelector(".tog") as HTMLElement | null;
  if (tog) {
    setIcon(tog, hidden ? "chevron-right" : "chevron-down");
    tog.title = t(hidden ? "web.action.show" : "web.action.hide");
  }
  scroll();
}

hooks.afterFeedAppend = (feed, node) => {
  if (!collapseSteps()) return;
  if (isActivity(node)) groupNode(feed, node);
  else if (node.matches(BOUNDARY)) groups.delete(feed);
};
hooks.afterConfig = () => syncStepFolding();
