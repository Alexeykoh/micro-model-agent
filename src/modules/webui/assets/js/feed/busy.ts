// In-feed busy indicator and read-only run folding. Extracted from `core.ts`;
// consumed by the stream/turn clusters and re-exported by `feed.js`. Imports
// the container primitives it needs from `core.js`, so the edge stays one-way.
import { el } from "../dom.js";
import { t, pluralCount } from "../i18n.js";
import { streamStateFor } from "../store.js";
import type { FeedStreamState } from "../store.js";
import { formatMs, verbosity } from "../format.js";
import { createFace } from "../loader.js";
import {
  activityLabel,
  activityStart,
  activitySubscribe,
  activityTimeText,
} from "../core/activity.js";
import { liveFeed, clearEmpty, appendTo, sessionIdForFeed } from "./core.js";

export function clearBusy(feed?: HTMLElement | null): void {
  feed = feed || liveFeed();
  if (!feed) return;
  const st = streamStateFor(feed);
  if (st.busyTimer) {
    clearInterval(st.busyTimer);
    st.busyTimer = null;
  }
  if (st.busyUnsub) {
    st.busyUnsub();
    st.busyUnsub = null;
  }
  const line = feed.querySelector(".busy");
  if (line) line.remove();
}

// Show the in-feed "thinking" line. Called immediately after a successful
// `/api/message` POST (202) so the wait during a slow first-run
// summarization is visible before the first `phase` event arrives; the
// normal event flow (`onText`/`onPhase`/`onTurnEnd`) clears it.
//
// Подпись и время берутся из общего состояния хода (`core/activity.ts`):
// строка в ленте и рельс над композером показывают одну фазу и одни секунды.
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
  if (st.busyUnsub) {
    st.busyUnsub();
    st.busyUnsub = null;
  }
  const key = sessionIdForFeed(feed);
  // Часы хода: старт с момента, когда стало понятно, что ход идёт (первое
  // событие хода или эта строка). Лента и рельс считают от одного старта.
  activityStart(key);
  const line = el("div", "busy");
  line.appendChild(createFace("think", "sm"));
  const lab = el("span", "lab", activityLabel(key));
  line.appendChild(lab);
  const time = el("span", "busytime", "· " + activityTimeText(key));
  line.appendChild(time);
  line.appendChild(el("span", "", "· " + t("web.input.esc")));
  appendTo(feed, line);
  const update = (): void => {
    if (!line.parentNode) {
      // Строку убрали из ленты (например, подрезка) — таймер и подписку гасим.
      if (st.busyTimer) {
        clearInterval(st.busyTimer);
        st.busyTimer = null;
      }
      if (st.busyUnsub) {
        st.busyUnsub();
        st.busyUnsub = null;
      }
      return;
    }
    lab.textContent = activityLabel(key);
    time.textContent = "· " + activityTimeText(key);
  };
  st.busyUnsub = activitySubscribe(key, update);
  st.busyTimer = setInterval(update, 1000);
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
