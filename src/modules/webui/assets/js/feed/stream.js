// Streaming text/reasoning/meta/phase/retract handlers for the feed.
// Extracted from `feed.js`; `feed.js` re-exports this module's public surface.
import { msgs, el, setIcon } from "../dom.js";
import { t } from "../i18n.js";
import { S } from "../store.js";
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
let textFeed = null;
let textScheduled = false;

function flushText() {
  textScheduled = false;
  if (!textBuf || !S.curMd) {
    textBuf = "";
    textFeed = null;
    return;
  }
  const buf = textBuf;
  const feed = textFeed;
  textBuf = "";
  textFeed = null;
  S.curMd.write(buf);
  if (feed && feed === activeFeed()) scroll();
}

function scheduleText() {
  if (textScheduled) return;
  textScheduled = true;
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(flushText);
  } else {
    flushText();
  }
}

// Close the active Markdown segment (if any) and clear the text S.state.
export function finishMd() {
  flushText();
  if (S.curMd) {
    S.curMd.root.classList.remove("streaming");
    S.curMd.end();
    S.curMd = null;
  }
  S.curText = null;
}

export function onText(chunk, sid) {
  const feed = feedForEvent(sid);
  clearBusy(feed);
  if (!feed) return;
  clearEmpty(feed);
  if (S.curThink) {
    finishThink();
  }
  if (S.curText == null) {
    flushRun();
    S.curText = "";
    S.curMd = mountMarkdown(feed, mdOpts(true));
    S.curMd.root.classList.add("streaming");
    S.turnRoots.push(S.curMd.root);
  }
  S.curText += chunk;
  S.turnMd += chunk;
  // A second session streaming concurrently must not merge into another feed's buffer.
  if (textFeed && textFeed !== feed) flushText();
  textFeed = feed;
  textBuf += chunk;
  scheduleText();
}

export function finishThink() {
  if (S.curThink) {
    if (S.curThink.wrap) S.curThink.wrap.classList.remove("live");
    if (S.curThink.startedAt) {
      const dur = S.curThink.head.querySelector(".dur");
      if (dur) dur.textContent = "· " + ((Date.now() - S.curThink.startedAt) / 1000).toFixed(1) + "s";
    }
  }
  S.curThink = null;
}

export function onReasoning(chunk, sid) {
  const feed = feedForEvent(sid);
  clearBusy(feed);
  if (!feed) return;
  clearEmpty(feed);
  finishMd();
  if (!S.curThink) {
    flushRun();
    const { wrap, head, body } = buildThinkBlock(true);
    appendTo(feed, wrap);
    S.curThink = { wrap, head, body, startedAt: Date.now() };
  }
  S.curThink.body.textContent += chunk;
  if (feed === activeFeed()) scroll();
}

// Generic agent status (context stats, compaction, MoE status, warnings):
// always visible, one dim line per chunk, never collapsed. Tool bodies
// (`kind: "tool"` — display/output/diff/failure-gist from ToolBatch) are
// model-facing and hidden in quiet mode, mirroring the terminal renderer
// (`writeInlineBody`); failures still surface once via `tool_end` ↳ cause.
export function onMeta(chunk, sid, kind) {
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
export function onRetract(reason, sid) {
  const feed = feedForEvent(sid);
  if (!feed) return;
  clearBusy(feed);
  const draftRoot = S.curMd ? S.curMd.root : null;
  const hadDraft = !!draftRoot || (S.curText != null && S.curText !== "");
  const draftLen = S.curText ? S.curText.length : 0;
  finishMd();
  finishThink();
  if (draftRoot) {
    const idx = S.turnRoots.indexOf(draftRoot);
    if (idx !== -1) S.turnRoots.splice(idx, 1);
    draftRoot.remove();
  }
  if (draftLen > 0) S.turnMd = S.turnMd.slice(0, Math.max(0, S.turnMd.length - draftLen));
  if (!hadDraft) return;
  if (reason) appendTo(feed, el("div", "metaln", reason));
  if (feed === activeFeed()) scroll();
}

export function onPhase(phase, sid) {
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
  const head = e.target.closest(".think-h");
  if (!head) return;
  const body = head.nextElementSibling;
  if (!body) return;
  const hidden = body.classList.toggle("hidden");
  head.setAttribute("aria-expanded", hidden ? "false" : "true");
  const tog = head.querySelector(".tog");
  if (tog) setIcon(tog, hidden ? "chevron-right" : "chevron-down", t(hidden ? "web.action.show" : "web.action.hide"));
});
