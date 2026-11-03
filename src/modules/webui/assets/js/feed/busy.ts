// In-feed busy indicator and read-only run folding. Extracted from `core.ts`;
// consumed by the stream/turn clusters and re-exported by `feed.js`. Imports
// the container primitives it needs from `core.js`, so the edge stays one-way.
import { el } from "../dom.js";
import { t, pluralCount } from "../i18n.js";
import { streamStateFor } from "../store.js";
import type { FeedStreamState } from "../store.js";
import { formatMs, verbosity } from "../format.js";
import { createFace } from "../loader.js";
import { liveFeed, clearEmpty, appendTo } from "./core.js";

export function clearBusy(feed?: HTMLElement | null): void {
  feed = feed || liveFeed();
  if (!feed) return;
  const st = streamStateFor(feed);
  if (st.busyTimer) {
    clearInterval(st.busyTimer);
    st.busyTimer = null;
  }
  const line = feed.querySelector(".busy");
  if (line) line.remove();
}

// Show the in-feed "thinking" line. Called immediately after a successful
// `/api/message` POST (202) so the wait during a slow first-run
// summarization is visible before the first `phase` event arrives; the
// normal event flow (`onText`/`onPhase`/`onTurnEnd`) clears it.
export function showBusy(feed?: HTMLElement | null): void {
  feed = feed || liveFeed();
  if (!feed) return;
  const st = streamStateFor(feed);
  // The delayed post-send call must not flash a spinner over a stream that
  // already started (fast first token).
  if (st.curMd || st.curThink) return;
  clearEmpty(feed);
  if (feed.querySelector(".busy")) return;
  if (st.busyTimer) {
    clearInterval(st.busyTimer);
    st.busyTimer = null;
  }
  const line = el("div", "busy");
  line.appendChild(createFace("think", "sm"));
  line.appendChild(el("span", "lab", t("web.action.thinking")));
  const time = el("span", "busytime", "· 0s");
  line.appendChild(time);
  line.appendChild(el("span", "", "· " + t("web.input.esc")));
  appendTo(feed, line);
  const started = Date.now();
  st.busyTimer = setInterval(() => {
    if (!line.parentNode) {
      clearInterval(st.busyTimer);
      st.busyTimer = null;
      return;
    }
    time.textContent = "· " + Math.round((Date.now() - started) / 1000) + "s";
  }, 1000);
}

export function flushRun(feed?: HTMLElement | null): void {
  feed = feed || liveFeed();
  if (!feed) return;
  const st = streamStateFor(feed);
  if (st.runCount <= 0) {
    resetRun(st);
    return;
  }
  // Quiet: a run of successful read-only actions folds into one summary line,
  // replacing the per-action lines (mirrors `Renderer.flushRecon`). `normal`
  // and `verbose` keep the individual action lines and add nothing.
  if (verbosity() === "quiet" && st.runReconOnly && st.runFails === 0 && st.runCount > 1) {
    // Fade the folded lines out instead of snapping them away.
    const folding = st.runNodes.slice();
    folding.forEach((node) => node.classList.add("fold-out"));
    window.setTimeout(() => folding.forEach((node) => node.remove()), 160);
    const line = el("div", "grouped");
    line.appendChild(el("span", "pipe", "│"));
    const dur = formatMs(st.runDuration);
    line.appendChild(
      document.createTextNode(
        " " + pluralCount("web.action.actions", st.runCount) + " ✓" + (dur ? " · " + dur : ""),
      ),
    );
    appendTo(feed, line);
  }
  resetRun(st);
}

function resetRun(st: FeedStreamState): void {
  st.runCount = 0;
  st.runFails = 0;
  st.runReconOnly = true;
  st.runNodes = [];
  st.runDuration = 0;
}
