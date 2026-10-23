// Feed container + sticky-scroll + read-only run folding for `mma web`.
// Extracted from `feed.js`; the streaming/turn/history handlers stay there and
// import these primitives. `feed.js` re-exports this module's public surface.
import { msgs, el, icon, setIcon } from "../dom.js";
import { t, pluralCount } from "../i18n.js";
import { streamStateFor, tabs as tabState, hooks } from "../store.js";
import type { FeedStreamState } from "../store.js";
import { formatMs, verbosity } from "../format.js";
import { copyText } from "../../md.js";
import { createFace } from "../loader.js";
import { getUpdateInfo, isUpdateDismissed } from "../update-state.js";
import { updateCard } from "./update-card.js";

// ---------------------------------------------------------------------------
// Shared render helpers used by the stream/turn/history clusters. They live
// here (the base module every cluster imports) so those clusters never need to
// import one another.
// ---------------------------------------------------------------------------

export interface MdOpts {
  copyLabel: string;
  copiedLabel: string;
  copyFailedLabel: string;
  animate: boolean;
}

// Options passed to the streaming Markdown renderer: localized code-block copy
// labels. Highlighting is applied by `md.js` once a fence closes. `animate`
// wraps live-streamed text chunks in `span.tk` (CSS `tkIn` fade); history
// render and code blocks skip it.
export function mdOpts(animate?: boolean): MdOpts {
  return {
    copyLabel: t("web.code.copy"),
    copiedLabel: t("web.code.copied"),
    copyFailedLabel: t("web.code.copy_failed"),
    animate: animate === true,
  };
}

export interface ThinkBlock {
  wrap: HTMLElement;
  head: HTMLButtonElement;
  body: HTMLElement;
}

// Build the collapsible reasoning block. The global `.think-h` click handler
// depends on this exact structure: wrap > [head, body], body carries `hidden`.
// `live` marks an in-progress block (pulsing label); history renders static.
export function buildThinkBlock(withDur: boolean, live?: boolean): ThinkBlock {
  const wrap = el("div", "think" + (live === false ? "" : " live"));
  const head = el("button", "think-h");
  head.type = "button";
  head.setAttribute("aria-expanded", "false");
  head.appendChild(el("span", "g", "✦"));
  head.appendChild(el("span", "lab", t("web.action.thinking")));
  if (withDur) head.appendChild(el("span", "dur", ""));
  const tog = el("span", "tog");
  setIcon(tog, "chevron-right", t("web.action.show"));
  head.appendChild(tog);
  const body = el("div", "think-body hidden");
  wrap.appendChild(head);
  wrap.appendChild(body);
  return { wrap, head, body };
}

// Build the user-message block. Attachments form a strip ABOVE the text, so the
// reading order is "what was attached" → "what was asked"; the `> ` prompt
// marker stays on the text line (never floats over the strip). Handles zero, one
// or many attachments; images become thumbnails, anything else a file chip.
export function userBlock(text: string, attachments?: string[] | null): HTMLElement {
  const node = el("div", "u");
  const atts = (attachments || []).filter((s): s is string => typeof s === "string" && s.length > 0);
  if (atts.length) {
    const strip = el("div", "u-attach");
    for (const src of atts) strip.appendChild(attachmentNode(src));
    node.appendChild(strip);
  }
  const body = el("div", "u-text");
  body.textContent = text || "";
  node.appendChild(body);
  return node;
}

// Image sources render as lazy thumbnails; anything else (a file path or a
// non-image data URL) renders as a compact chip with its name.
function attachmentNode(src: string): HTMLElement {
  if (isImageSrc(src)) {
    const img = document.createElement("img");
    img.className = "uimg";
    img.alt = "";
    img.loading = "lazy";
    img.src = src;
    return img;
  }
  const chip = el("div", "u-file");
  chip.appendChild(icon("file", "u-file-ico"));
  chip.appendChild(el("span", "u-file-name", attachmentLabel(src)));
  return chip;
}

function isImageSrc(src: string): boolean {
  // data URLs: only `data:image/*` is an image; other data mimes are files.
  if (/^data:/i.test(src)) return /^data:image\//i.test(src);
  // everything else (absolute, relative `/api/sessions/.../a.png`, or a path)
  // is decided by its extension.
  return /\.(png|jpe?g|gif|webp|bmp|svg|avif|tiff?)(\?|#|$)/i.test(src);
}

function attachmentLabel(src: string): string {
  const data = /^data:([^;,]+)/i.exec(src);
  if (data) return data[1];
  const clean = src.split(/[?#]/)[0];
  return clean.split(/[\\/]/).pop() || src;
}

// Per-message copy action button (whole response as plain text / as Markdown).
export function copyAction(payload: string, labelKey: string): HTMLButtonElement {
  const btn = el("button", "act-btn", t(labelKey));
  btn.type = "button";
  btn.addEventListener("click", () => {
    copyText(payload).then((ok: boolean) => {
      btn.textContent = ok ? "✓ " + t("web.code.copied") : "⚠ " + t("web.code.copy_failed");
      window.setTimeout(() => {
        btn.textContent = t(labelKey);
      }, 1400);
    });
  });
  return btn;
}

// Copy-actions row appended after a completed assistant answer.
export function appendActionsRow(
  feed: HTMLElement | null,
  plain: string | null | undefined,
  markdown: string | null | undefined,
): void {
  const text = String(plain == null ? "" : plain);
  const md = String(markdown == null ? "" : markdown);
  if (!feed || (!text.trim() && !md.trim())) return;
  const bar = el("div", "msg-actions");
  if (text.trim()) bar.appendChild(copyAction(text, "web.msg.copy"));
  if (md.trim()) bar.appendChild(copyAction(md, "web.msg.copy_md"));
  appendTo(feed, bar);
}

export function insertAfter(ref: Node | null, node: Node): void {
  if (ref && ref.parentNode) ref.parentNode.insertBefore(node, ref.nextSibling);
  else appendTo(liveFeed(), node);
}

function emptyView(): HTMLElement {
  const wrap = el("div", "empty");
  wrap.appendChild(el("span", "g", "✦"));
  wrap.appendChild(document.createTextNode(" " + t("web.empty.title")));
  wrap.appendChild(document.createElement("br"));
  wrap.appendChild(el("span", "hint", t("web.empty.hint")));
  const upd = getUpdateInfo();
  if (upd && !isUpdateDismissed()) wrap.appendChild(updateCard(upd));
  return wrap;
}

export function makeFeed(): HTMLElement {
  const feed = el("div", "feed");
  feed.appendChild(emptyView());
  return feed;
}

export function showEmptyFeed(): void {
  hooks.beforeFeedMount?.();
  msgs.replaceChildren(emptyView());
  follow = true;
  hideToLatest();
  syncUrl();
}

export function clearFeed(feed: HTMLElement | null): void {
  if (!feed) return;
  feed.replaceChildren(emptyView());
  follow = true;
  hideToLatest();
  const tab = tabState.tabs.find((x) => x.feed === feed);
  if (tab) tab.planCard = null;
  if (feed === activeFeed()) scroll();
}

export function activeFeed(): HTMLElement | null {
  // Пока открыт прогон субагента, лента вкладки смонтирована «за кадром»:
  // её события обязаны продолжать копиться, но скроллить чужой вид нельзя.
  if (tabState.subagentRunId) return null;
  const tab = tabState.tabs.find((x) => x.id === tabState.activeTabId);
  return tab ? tab.feed : null;
}

export function liveFeed(): HTMLElement | null {
  const tab = tabState.tabs.find((x) => x.id === tabState.liveTabId) || tabState.tabs.find((x) => x.id === tabState.activeTabId);
  return tab ? tab.feed : null;
}

// Route a server event to the tab that owns its session (item from `broadcast`
// enrichment); fall back to the live/active tab for events without one.
export function feedForEvent(sessionId?: string | null): HTMLElement | null {
  if (sessionId) {
    const tab = tabState.tabs.find((x) => x.id === sessionId);
    if (tab) return tab.feed;
  }
  return liveFeed();
}

function nearBottom(): boolean {
  return msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 140;
}

// Sticky follow: while the reader is at the live edge we pin to the bottom
// on every append; the moment they scroll up we leave them alone (the
// "jump to latest" pill offers the trip back). A new user turn always
// force-scrolls — otherwise one missed pin cascades into "no autoscroll"
// for the whole turn, since every later `scroll()` would see `nearBottom()`
// as false and skip.
let follow = true;

export function scroll(force?: boolean): void {
  if (force || follow || nearBottom()) {
    msgs.scrollTop = msgs.scrollHeight;
    follow = true;
    hideToLatest();
  } else {
    maybeShowToLatest();
  }
}

// Force-pin to the live edge (send / history load / pill click).
export function scrollToBottom(smooth?: boolean): void {
  follow = true;
  hideToLatest();
  if (smooth && typeof msgs.scrollTo === "function") {
    try {
      msgs.scrollTo({ top: msgs.scrollHeight, behavior: "smooth" });
      return;
    } catch {
      /* fall through to instant */
    }
  }
  msgs.scrollTop = msgs.scrollHeight;
}

export function isFollowing(): boolean {
  return follow;
}

/** Монтирует ленту вкладки в `#msgs`, закрывая открытый вид субагента. */
export function mountFeed(feed: HTMLElement | null): void {
  hooks.beforeFeedMount?.();
  if (feed) msgs.replaceChildren(feed);
}

export function feedHasContent(feed: HTMLElement): boolean {
  // `.detail` тоже контент: строки статуса/ошибок загрузки ("история
  // недоступна") не должны провоцировать повторный fetch при каждом открытии
  // вкладки — иначе каждый клик плодит ещё одну строку (сессия удалена,
  // сервер отвечает 404, а фид "пуст" снова и снова).
  return !!feed.querySelector(".u, .md, .ans, .code, .act, .think, .metaln, .errline, .sysline, .detail");
}

export function syncUrl(): void {
  const url = new URL(location.href);
  const tab = tabState.tabs.find((x) => x.id === tabState.activeTabId);
  if (tab && tab.kind === "session") url.searchParams.set("session", tab.id);
  else url.searchParams.delete("session");
  history.replaceState(null, "", url);
}

// Floating "jump to latest" pill: appears only when the reader scrolled up
// and new content landed below. Created lazily so tests/SSR without `.chat`
// never break.
let toLatestBtn: HTMLButtonElement | null = null;
function ensureToLatest(): HTMLButtonElement | null {
  if (toLatestBtn) return toLatestBtn;
  // Anchor to the composer so the pill floats a fixed gap above it; `.input-area`
  // is `position: relative` (same containing block as `.menu`/`.cmdk`). Fall back
  // to `.chat` for bare test DOMs without a composer.
  const host = document.querySelector(".input-area") || document.querySelector(".chat");
  if (!host) return null;
  toLatestBtn = el("button", "to-latest");
  toLatestBtn.type = "button";
  toLatestBtn.hidden = true;
  toLatestBtn.addEventListener("click", () => scrollToBottom(true));
  host.appendChild(toLatestBtn);
  return toLatestBtn;
}

function maybeShowToLatest(): void {
  const btn = ensureToLatest();
  if (!btn) return;
  btn.textContent = "↓ " + t("web.scroll.latest");
  btn.hidden = false;
  msgs.classList.add("unfollowed");
}

function hideToLatest(): void {
  if (toLatestBtn) toLatestBtn.hidden = true;
  msgs.classList.remove("unfollowed");
}

// `?.` — модульный кэш в тестовом процессе общий: DOM-модуль может
// оцениться раньше, чем в документе появился `#msgs`. В живой странице
// элемент есть всегда.
msgs?.addEventListener("scroll", () => {
  const nb = nearBottom();
  follow = nb;
  msgs.classList.toggle("scrolled", msgs.scrollTop > 24);
  if (nb) hideToLatest();
  else if (liveFeed() && feedHasContent(liveFeed() as HTMLElement)) maybeShowToLatest();
});

export function appendTo<T extends Node>(feed: HTMLElement | null, node: T): T {
  if (!feed) return node;
  feed.appendChild(node);
  trimFeed(feed);
  if (feed === activeFeed()) scroll();
  return node;
}

/**
 * Сколько верхнеуровневых узлов держим в ленте. Лента растёт всю сессию, и
 * без предела DOM пухнет (аудит §6.15): старые узлы уходят, как в кольце.
 */
export const FEED_MAX_NODES = 400;

/** Убирает самые старые узлы ленты, пока их больше предела. */
function trimFeed(feed: HTMLElement): void {
  while (feed.childElementCount > FEED_MAX_NODES) {
    const first = feed.firstElementChild;
    if (!first) return;
    first.remove();
  }
}

export function clearEmpty(feed: HTMLElement | null): void {
  const empty = feed && feed.querySelector(".empty");
  if (empty) empty.remove();
}

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
