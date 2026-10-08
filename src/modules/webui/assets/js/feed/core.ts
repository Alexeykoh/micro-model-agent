// Feed container + sticky-scroll + read-only run folding for `mma web`.
// Extracted from `feed.js`; the streaming/turn/history handlers stay there and
// import these primitives. `feed.js` re-exports this module's public surface.
import { msgs, el, setIcon } from "../dom.js";
import { t, pluralCount } from "../i18n.js";
import { feed as feedState, tabs as tabState } from "../store.js";
import { formatMs, verbosity } from "../format.js";
import { copyText } from "../../md.js";
import { createFace } from "../loader.js";

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
  return wrap;
}

export function makeFeed(): HTMLElement {
  const feed = el("div", "feed");
  feed.appendChild(emptyView());
  return feed;
}

export function showEmptyFeed(): void {
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
  const chat = document.querySelector(".chat");
  if (!chat) return null;
  toLatestBtn = el("button", "to-latest");
  toLatestBtn.type = "button";
  toLatestBtn.hidden = true;
  toLatestBtn.addEventListener("click", () => scrollToBottom(true));
  chat.appendChild(toLatestBtn);
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
  if (feed === activeFeed()) scroll();
  return node;
}

export function clearEmpty(feed: HTMLElement | null): void {
  const empty = feed && feed.querySelector(".empty");
  if (empty) empty.remove();
}

export function clearBusy(feed?: HTMLElement | null): void {
  if (feedState.busyTimer) {
    clearInterval(feedState.busyTimer);
    feedState.busyTimer = null;
  }
  feed = feed || liveFeed();
  if (!feed) return;
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
  // The delayed post-send call must not flash a spinner over a stream that
  // already started (fast first token).
  if (feedState.curMd || feedState.curThink) return;
  clearEmpty(feed);
  if (feed.querySelector(".busy")) return;
  if (feedState.busyTimer) {
    clearInterval(feedState.busyTimer);
    feedState.busyTimer = null;
  }
  const line = el("div", "busy");
  line.appendChild(createFace("think", "sm"));
  line.appendChild(el("span", "lab", t("web.action.thinking")));
  const time = el("span", "busytime", "· 0s");
  line.appendChild(time);
  line.appendChild(el("span", "", "· " + t("web.input.esc")));
  appendTo(feed, line);
  const started = Date.now();
  feedState.busyTimer = setInterval(() => {
    if (!line.parentNode) {
      clearInterval(feedState.busyTimer);
      feedState.busyTimer = null;
      return;
    }
    time.textContent = "· " + Math.round((Date.now() - started) / 1000) + "s";
  }, 1000);
}

export function flushRun(): void {
  if (feedState.runCount <= 0) {
    resetRun();
    return;
  }
  // Quiet: a run of successful read-only actions folds into one summary line,
  // replacing the per-action lines (mirrors `Renderer.flushRecon`). `normal`
  // and `verbose` keep the individual action lines and add nothing.
  if (verbosity() === "quiet" && feedState.runReconOnly && feedState.runFails === 0 && feedState.runCount > 1) {
    // Fade the folded lines out instead of snapping them away.
    const folding = feedState.runNodes.slice();
    folding.forEach((node) => node.classList.add("fold-out"));
    window.setTimeout(() => folding.forEach((node) => node.remove()), 160);
    const line = el("div", "grouped");
    line.appendChild(el("span", "pipe", "│"));
    const dur = formatMs(feedState.runDuration);
    line.appendChild(
      document.createTextNode(
        " " + pluralCount("web.action.actions", feedState.runCount) + " ✓" + (dur ? " · " + dur : ""),
      ),
    );
    appendTo(liveFeed(), line);
  }
  resetRun();
}

function resetRun(): void {
  feedState.runCount = 0;
  feedState.runFails = 0;
  feedState.runReconOnly = true;
  feedState.runNodes = [];
  feedState.runDuration = 0;
}
