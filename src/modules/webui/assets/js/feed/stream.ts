// Streaming text/reasoning/meta/phase/retract handlers for the feed.
// Extracted from `feed.js`; `feed.js` re-exports this module's public surface.
import { msgs, el, setIcon } from "../dom.js";
import { t } from "../i18n.js";
import { streamStateFor } from "../store.js";
import { verbosity } from "../format.js";
import { mountMarkdown } from "../../md.js";
import {
  activeFeed, feedForEvent, clearBusy, clearEmpty, flushRun, showBusy,
  appendTo, scroll, mdOpts, buildThinkBlock,
} from "./core.js";

// Text chunks arrive in bursts (several SSE `text` events per frame); writing
// and scrolling on every one thrashes layout and stacks overlapping `tkIn`
// fades ("рвано"). Buffer per feed and flush once per animation frame instead.
function flushText(feed: HTMLElement): void {
  const st = streamStateFor(feed);
  st.textScheduled = false;
  if (!st.pendingText || !st.curMd) {
    st.pendingText = "";
    return;
  }
  const buf = st.pendingText;
  st.pendingText = "";
  st.curMd.write(buf);
  if (feed === activeFeed()) scroll();
}

function scheduleText(feed: HTMLElement): void {
  const st = streamStateFor(feed);
  if (st.textScheduled) return;
  st.textScheduled = true;
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(() => flushText(feed));
  } else {
    flushText(feed);
  }
}

// Close the Markdown segment owned by `feed` (if any) and clear its text state.
export function finishMd(feed?: HTMLElement | null): void {
  if (!feed) return;
  const st = streamStateFor(feed);
  flushText(feed);
  if (st.curMd) {
    st.curMd.root.classList.remove("streaming");
    st.curMd.end();
    st.curMd = null;
  }
  st.curText = null;
}

export function onText(chunk: string, sid?: string): void {
  const feed = feedForEvent(sid);
  clearBusy(feed);
  if (!feed) return;
  clearEmpty(feed);
  const st = streamStateFor(feed);
  if (st.curThink) {
    finishThink(feed);
  }
  if (st.curText == null) {
    flushRun(feed);
    st.curText = "";
    st.curMd = mountMarkdown(feed, mdOpts(true));
    st.curMd.root.classList.add("streaming");
    st.turnRoots.push(st.curMd.root);
  }
  st.curText += chunk;
  st.turnMd += chunk;
  st.pendingText += chunk;
  scheduleText(feed);
}

export function finishThink(feed?: HTMLElement | null): void {
  if (!feed) return;
  const st = streamStateFor(feed);
  if (st.curThink) {
    if (st.curThink.wrap) st.curThink.wrap.classList.remove("live");
    if (st.curThink.startedAt) {
      const dur = st.curThink.head.querySelector(".dur");
      if (dur) dur.textContent = "· " + ((Date.now() - st.curThink.startedAt) / 1000).toFixed(1) + "s";
    }
  }
  st.curThink = null;
}

export function onReasoning(
  chunk: string,
  sid?: string,
  info?: { level?: string; source?: string },
): void {
  const feed = feedForEvent(sid);
  clearBusy(feed);
  if (!feed) return;
  clearEmpty(feed);
  finishMd(feed);
  const st = streamStateFor(feed);
  if (!st.curThink) {
    flushRun(feed);
    const { wrap, head, body } = buildThinkBlock(true, undefined, info);
    appendTo(feed, wrap);
    st.curThink = { wrap, head, body, startedAt: Date.now() };
  }
  st.curThink.body.textContent += chunk;
  if (feed === activeFeed()) scroll();
}

// Generic agent status (context stats, compaction, warnings):
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
  finishMd(feed);
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
  const st = streamStateFor(feed);
  const draftRoot = st.curMd ? st.curMd.root : null;
  const hadDraft = !!draftRoot || (st.curText != null && st.curText !== "");
  const draftLen = st.curText ? st.curText.length : 0;
  finishMd(feed);
  finishThink(feed);
  if (draftRoot) {
    const idx = st.turnRoots.indexOf(draftRoot);
    if (idx !== -1) st.turnRoots.splice(idx, 1);
    draftRoot.remove();
  }
  if (draftLen > 0) st.turnMd = st.turnMd.slice(0, Math.max(0, st.turnMd.length - draftLen));
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
// built by `buildThinkBlock`). `?.` — как в feed/core: в тестовом процессе
// модульный кэш общий и `#msgs` может отсутствовать на момент оценки.
msgs?.addEventListener("click", (e) => {
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
