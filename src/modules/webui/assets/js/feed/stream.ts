// Streaming text/reasoning/meta/phase/retract handlers for the feed.
// Extracted from `feed.js`; `feed.js` re-exports this module's public surface.
import { msgs, el, setIcon } from "../dom.js";
import { t } from "../i18n.js";
import { feed as feedState } from "../store.js";
import { verbosity } from "../format.js";
import { mountMarkdown } from "../../md.js";
import {
  activeFeed, feedForEvent, clearBusy, clearEmpty, flushRun, showBusy,
  appendTo, scroll, mdOpts, buildThinkBlock,
} from "./core.js";

// Text chunks arrive in bursts (several SSE `text` events per frame); writing
// and scrolling on every one thrashes layout and stacks overlapping `tkIn`
// fades ("рвано"). Buffer them and flush once per animation frame instead.
let textBuf = "";
let textFeed: HTMLElement | null = null;
let textScheduled = false;

function flushText(): void {
  textScheduled = false;
  if (!textBuf || !feedState.curMd) {
    textBuf = "";
    textFeed = null;
    return;
  }
  const buf = textBuf;
  const feed = textFeed;
  textBuf = "";
  textFeed = null;
  feedState.curMd.write(buf);
  if (feed && feed === activeFeed()) scroll();
}

function scheduleText(): void {
  if (textScheduled) return;
  textScheduled = true;
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(flushText);
  } else {
    flushText();
  }
}

// Close the active Markdown segment (if any) and clear the feed text state.
export function finishMd(): void {
  flushText();
  if (feedState.curMd) {
    feedState.curMd.root.classList.remove("streaming");
    feedState.curMd.end();
    feedState.curMd = null;
  }
  feedState.curText = null;
}

export function onText(chunk: string, sid?: string): void {
  const feed = feedForEvent(sid);
  clearBusy(feed);
  if (!feed) return;
  clearEmpty(feed);
  if (feedState.curThink) {
    finishThink();
  }
  if (feedState.curText == null) {
    flushRun();
    feedState.curText = "";
    feedState.curMd = mountMarkdown(feed, mdOpts(true));
    feedState.curMd.root.classList.add("streaming");
    feedState.turnRoots.push(feedState.curMd.root);
  }
  feedState.curText += chunk;
  feedState.turnMd += chunk;
  // A second session streaming concurrently must not merge into another feed's buffer.
  if (textFeed && textFeed !== feed) flushText();
  textFeed = feed;
  textBuf += chunk;
  scheduleText();
}

export function finishThink(): void {
  if (feedState.curThink) {
    if (feedState.curThink.wrap) feedState.curThink.wrap.classList.remove("live");
    if (feedState.curThink.startedAt) {
      const dur = feedState.curThink.head.querySelector(".dur");
      if (dur) dur.textContent = "· " + ((Date.now() - feedState.curThink.startedAt) / 1000).toFixed(1) + "s";
    }
  }
  feedState.curThink = null;
}

export function onReasoning(chunk: string, sid?: string): void {
  const feed = feedForEvent(sid);
  clearBusy(feed);
  if (!feed) return;
  clearEmpty(feed);
  finishMd();
  if (!feedState.curThink) {
    flushRun();
    const { wrap, head, body } = buildThinkBlock(true);
    appendTo(feed, wrap);
    feedState.curThink = { wrap, head, body, startedAt: Date.now() };
  }
  feedState.curThink.body.textContent += chunk;
  if (feed === activeFeed()) scroll();
}

// Generic agent status (context stats, compaction, MoE status, warnings):
// always visible, one dim line per chunk, never collapsed. Tool bodies
// (`kind: "tool"` — display/output/diff/failure-gist from ToolBatch) are
// model-facing and hidden in quiet mode, mirroring the terminal renderer
// (`writeInlineBody`); failures still surface once via `tool_end` ↳ cause.
export function onMeta(chunk: string, sid?: string, kind?: string): void {
  if (kind === "tool" && verbosity() === "quiet") return;
  const feed = feedForEvent(sid);
  clearBusy(feed);
  const text = (chunk || "").trim();
  if (!feed || !text) return;
  clearEmpty(feed);
  finishMd();
  const warn = text.indexOf("⚠") !== -1 || text.indexOf("✗") !== -1;
  appendTo(feed, el("div", warn ? "metaln warn" : "metaln", text));
  if (feed === activeFeed()) scroll();
}

// Гейт забраковал уже отстримленный черновик (SSE `retract`): убираем его
// из ленты до переответа, иначе финал встанет дублем следом
// (ses_munvrcfz_na9ze3). Копипаст хода тоже чистим — отклонённого текста
// в «copy / copy as markdown» быть не должно. Без видимого черновика
// (пустой ответ, только тулы) — тихо, без шумовой строки.
export function onRetract(reason: string, sid?: string): void {
  const feed = feedForEvent(sid);
  if (!feed) return;
  clearBusy(feed);
  const draftRoot = feedState.curMd ? feedState.curMd.root : null;
  const hadDraft = !!draftRoot || (feedState.curText != null && feedState.curText !== "");
  const draftLen = feedState.curText ? feedState.curText.length : 0;
  finishMd();
  finishThink();
  if (draftRoot) {
    const idx = feedState.turnRoots.indexOf(draftRoot);
    if (idx !== -1) feedState.turnRoots.splice(idx, 1);
    draftRoot.remove();
  }
  if (draftLen > 0) feedState.turnMd = feedState.turnMd.slice(0, Math.max(0, feedState.turnMd.length - draftLen));
  if (!hadDraft) return;
  if (reason) appendTo(feed, el("div", "metaln", reason));
  if (feed === activeFeed()) scroll();
}

export function onPhase(phase: string, sid?: string): void {
  const feed = feedForEvent(sid);
  if (phase === "thinking") {
    showBusy(feed);
  } else {
    clearBusy(feed);
  }
}

// Global `.think-h` toggle (depends on the wrap > [head, body] structure
// built by `buildThinkBlock`).
msgs.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const head = target.closest(".think-h");
  if (!head) return;
  const body = head.nextElementSibling;
  if (!body) return;
  const hidden = body.classList.toggle("hidden");
  head.setAttribute("aria-expanded", hidden ? "false" : "true");
  const tog = head.querySelector(".tog");
  if (tog) setIcon(tog as HTMLElement, hidden ? "chevron-right" : "chevron-down", t(hidden ? "web.action.show" : "web.action.hide"));
});
