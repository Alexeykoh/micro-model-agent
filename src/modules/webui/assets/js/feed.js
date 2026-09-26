// Feed, turn-stream handlers, history, question UI and sidebar renders.
// All SSE `on*` handlers live here; `app.js` only wires them to EventSource.
import { mountMarkdown, renderMarkdown, copyText } from "../md.js";
import {
msgs, planEl, planCountEl, usageEl, envEl, wsLine,
el, icon, setIcon, link, announce,
} from "./dom.js";
import { api } from "./api.js";
import { I18N, t, pluralCount } from "./i18n.js";
import { S } from "./store.js";
import {
FILE_TOOLS, OPENABLE_TOOLS, IMAGE_TOOLS, LINK_TOOLS,
categoryOf, labelOf, argText, formatMs, verbosity, firstOutputLine, fmtTokens,
} from "./format.js";

function insertAfter(ref, node) {
  if (ref && ref.parentNode) ref.parentNode.insertBefore(node, ref.nextSibling);
  else appendTo(liveFeed(), node);
}


function emptyView() {
  const wrap = el("div", "empty");
  wrap.appendChild(el("span", "g", "✦"));
  wrap.appendChild(document.createTextNode(" " + t("web.empty.title")));
  wrap.appendChild(document.createElement("br"));
  wrap.appendChild(el("span", "hint", t("web.empty.hint")));
  return wrap;
}

export function makeFeed() {
  const feed = el("div", "feed");
  feed.appendChild(emptyView());
  return feed;
}

export function showEmptyFeed() {
  msgs.replaceChildren(emptyView());
  syncUrl();
}

export function clearFeed(feed) {
  if (!feed) return;
  feed.replaceChildren(emptyView());
  const tab = S.tabs.find((x) => x.feed === feed);
  if (tab) tab.planCard = null;
  if (feed === activeFeed()) scroll();
}

export function activeFeed() {
  const tab = S.tabs.find((x) => x.id === S.activeTabId);
  return tab ? tab.feed : null;
}

export function liveFeed() {
  const tab = S.tabs.find((x) => x.id === S.liveTabId) || S.tabs.find((x) => x.id === S.activeTabId);
  return tab ? tab.feed : null;
}

// Route a server event to the tab that owns its session (item from `broadcast`
// enrichment); fall back to the live/active tab for events without one.
function feedForEvent(sessionId) {
  if (sessionId) {
    const tab = S.tabs.find((x) => x.id === sessionId);
    if (tab) return tab.feed;
  }
  return liveFeed();
}

function nearBottom() {
  return msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 140;
}

function scroll() {
  if (nearBottom()) msgs.scrollTop = msgs.scrollHeight;
}

export function appendTo(feed, node) {
  if (!feed) return node;
  feed.appendChild(node);
  if (feed === activeFeed()) scroll();
  return node;
}

function append(node) {
  return appendTo(liveFeed(), node);
}

export function clearEmpty(feed) {
  const empty = feed && feed.querySelector(".empty");
  if (empty) empty.remove();
}

function clearBusy(feed) {
  if (S.busyTimer) {
    clearInterval(S.busyTimer);
    S.busyTimer = null;
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
export function showBusy(feed) {
  feed = feed || liveFeed();
  if (!feed) return;
  clearEmpty(feed);
  if (feed.querySelector(".busy")) return;
  if (S.busyTimer) {
    clearInterval(S.busyTimer);
    S.busyTimer = null;
  }
  const line = el("div", "busy");
  line.appendChild(el("span", "spin", "✦"));
  line.appendChild(el("span", "lab", t("web.action.thinking")));
  const time = el("span", "busytime", "· 0s");
  line.appendChild(time);
  line.appendChild(el("span", "", "· " + t("web.input.esc")));
  appendTo(feed, line);
  const started = Date.now();
  S.busyTimer = setInterval(() => {
    if (!line.parentNode) {
      clearInterval(S.busyTimer);
      S.busyTimer = null;
      return;
    }
    time.textContent = "· " + Math.round((Date.now() - started) / 1000) + "s";
  }, 1000);
}

function flushRun() {
  if (S.runCount <= 0) {
    resetRun();
    return;
  }
  // Quiet: a run of successful read-only actions folds into one summary line,
  // replacing the per-action lines (mirrors `Renderer.flushRecon`). `normal`
  // and `verbose` keep the individual action lines and add nothing.
  if (verbosity() === "quiet" && S.runReconOnly && S.runFails === 0 && S.runCount > 1) {
    S.runNodes.forEach((node) => node.remove());
    const line = el("div", "grouped");
    line.appendChild(el("span", "pipe", "│"));
    const dur = formatMs(S.runDuration);
    line.appendChild(
      document.createTextNode(
        " " + pluralCount("web.action.actions", S.runCount) + " ✓" + (dur ? " · " + dur : ""),
      ),
    );
    appendTo(liveFeed(), line);
  }
  resetRun();
}

function resetRun() {
  S.runCount = 0;
  S.runFails = 0;
  S.runReconOnly = true;
  S.runNodes = [];
  S.runDuration = 0;
}

// Options passed to the streaming Markdown renderer: localized code-block
// copy labels. Highlighting is applied by `md.js` once a fence closes.
function mdOpts() {
  return {
    copyLabel: t("web.code.copy"),
    copiedLabel: t("web.code.copied"),
    copyFailedLabel: t("web.code.copy_failed"),
  };
}

// Close the active Markdown segment (if any) and clear the text S.state.
export function finishMd() {
  if (S.curMd) {
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
    S.curMd = mountMarkdown(feed, mdOpts());
    S.turnRoots.push(S.curMd.root);
  }
  S.curText += chunk;
  S.turnMd += chunk;
  S.curMd.write(chunk);
  if (feed === activeFeed()) scroll();
}

export function finishThink() {
  if (S.curThink && S.curThink.startedAt) {
    const dur = S.curThink.head.querySelector(".dur");
    if (dur) dur.textContent = "· " + ((Date.now() - S.curThink.startedAt) / 1000).toFixed(1) + "s";
  }
  S.curThink = null;
}

// Build the collapsible reasoning block. The global `.think-h` click handler
// depends on this exact structure: wrap > [head, body], body carries `hidden`.
function buildThinkBlock(withDur) {
  const wrap = el("div", "think");
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
// always visible, one dim line per chunk, never collapsed.
export function onMeta(chunk, sid) {
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

export function onPhase(phase, sid) {
  const feed = feedForEvent(sid);
  if (phase === "thinking") {
    showBusy(feed);
  } else {
    clearBusy(feed);
  }
}

export function onToolStart(data) {
  const feed = feedForEvent(data.sessionId);
  clearBusy(feed);
  if (!feed) return;
  clearEmpty(feed);
  finishMd();
  finishThink();
  S.pendingArgs.set(data.toolCallId, data.args || {});
  const line = el("div", "act " + categoryOf(data.name));
  line.appendChild(el("span", "g", "◇"));
  line.appendChild(el("span", "lab", labelOf(data.name)));
  const args = argText(data.args);
  if (args) {
    line.appendChild(el("span", "sep", "·"));
    line.appendChild(el("span", "args", args));
  }
  const status = el("span", "ok", "");
  line.appendChild(status);
  appendTo(feed, line);
  S.toolNodes.set(data.toolCallId, { status, line });
  if (categoryOf(data.name) !== "recon") S.runReconOnly = false;
  S.runCount++;
}

function renderToolOutput(line, text) {
  if (typeof text !== "string" || !text) return;
  const wrap = el("div", "toolout");
  const code = el("div", "code");
  code.textContent = text;
  wrap.appendChild(code);
  const long = text.length > 600 || text.split("\n").length > 12;
  if (long) {
    wrap.classList.add("collapsed");
    const outLabel = "▸ " + pluralCount("web.tool.output", text.length);
    const more = el("span", "more", outLabel);
    more.addEventListener("click", () => {
      const collapsed = wrap.classList.toggle("collapsed");
      more.textContent = collapsed ? outLabel : "▾ " + t("web.tool.collapse");
    });
    wrap.appendChild(more);
  }
  const feed = line && line.parentNode ? null : liveFeed();
  if (line && line.parentNode) line.parentNode.insertBefore(wrap, line.nextSibling);
  else appendTo(feed, wrap);
}

function safeUrl(url) {
  if (typeof url !== "string" || !url) return null;
  try {
    const u = new URL(url, location.href);
    if (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "file:") {
      return u.href;
    }
  } catch (err) {
    return null;
  }
  return null;
}

function cardFor(name, args, sid) {
  const feed = feedForEvent(sid);
  if (!feed) return null;
  if (FILE_TOOLS.indexOf(name) !== -1) {
    const path = args.path || args.file || args.dir;
    if (!path) return null;
    const card = el("div", "filecard");
    const top = el("div", "fc-top");
    top.appendChild(el("span", "g", "◇"));
    const nameEl = el("span", "name", path);
    nameEl.title = path;
    top.appendChild(nameEl);
    card.appendChild(top);
    const bottom = el("div", "fc-bottom");
    bottom.appendChild(el("span", "lab", labelOf(name)));
    if (OPENABLE_TOOLS.indexOf(name) !== -1) {
      const openLink = el("a", "fc-open", t("web.card.open"));
      openLink.href = "/api/file?path=" + encodeURIComponent(path);
      openLink.target = "_blank";
      openLink.rel = "noopener noreferrer";
      bottom.appendChild(openLink);
    }
    card.appendChild(bottom);
    appendTo(feed, card);
    return card;
  }
  if (LINK_TOOLS.indexOf(name) !== -1 && args.url) {
    const line = el("div", "linkline");
    line.appendChild(document.createTextNode("↳ "));
    const safe = safeUrl(args.url);
    if (safe) {
      const a = el("a", "", args.url);
      a.href = safe;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      line.appendChild(a);
      try {
        const host = new URL(safe).hostname;
        if (host) line.appendChild(el("span", "dom", " · " + host));
      } catch (err) {
        /* no hostname */
      }
    } else {
      line.appendChild(el("span", "", args.url));
    }
    appendTo(feed, line);
    return line;
  }
  if (IMAGE_TOOLS.indexOf(name) !== -1) {
    const card = el("div", "imgcard");
    card.appendChild(el("div", "ph", "◧ " + t("web.card.screenshot")));
    card.appendChild(el("div", "cap", name === "attach_image" ? t("web.card.attached_image") : t("web.card.browser_viewport")));
    appendTo(feed, card);
    return card;
  }
  return null;
}

export function onToolEnd(data) {
  const node = S.toolNodes.get(data.toolCallId);
  const line = node ? node.line : null;
  if (node) {
    const dur = formatMs(data.durationMs);
    node.status.textContent = data.success ? " ✓" + (dur ? " " + dur : "") : " ✗" + (dur ? " " + dur : "");
    if (!data.success) {
      node.status.classList.add("fail");
      S.runFails++;
      S.runReconOnly = false;
    }
  }
  S.toolNodes.delete(data.toolCallId);
  const args = S.pendingArgs.get(data.toolCallId) || {};
  S.pendingArgs.delete(data.toolCallId);
  if (verbosity() === "quiet") {
    // Quiet hides tool bodies. Track successful nodes so a run of read-only
    // actions can fold at the next segment; a failure keeps its line and adds
    // a single `↳` cause instead of the whole model-facing body.
    if (data.success) {
      if (line) S.runNodes.push(line);
      const card = cardFor(data.name, args, data.sessionId);
      if (card) S.runNodes.push(card);
      S.runDuration += typeof data.durationMs === "number" ? data.durationMs : 0;
    } else {
      const cause = firstOutputLine(data.output);
      if (cause) insertAfter(line, el("div", "detail", "↳ " + cause));
    }
    return;
  }
  if (data.success) cardFor(data.name, args, data.sessionId);
  renderToolOutput(line, data.output);
}

export function onTurnEnd(data) {
  S.state.busy = false;
  const feed = feedForEvent(data.sessionId);
  clearBusy(feed);
  finishThink();
  finishMd();
  flushRun();
  const owner = S.tabs.find((x) => x.id === data.sessionId);
  if (owner) owner.planCard = null;
  if (!feed) {
    resetTurnText();
    return;
  }
  if (data.success === false) {
    if (data.interrupted) {
      appendTo(feed, el("div", "warnline", "⚠ " + t("web.turn.stopped")));
      announce(t("web.turn.stopped"));
    } else {
      appendTo(feed, el("div", "errline", "✗ " + t("web.turn.failed")));
      announce(t("web.turn.failed"));
    }
  } else {
    const parts = [];
    if (typeof data.toolCalls === "number" && data.toolCalls > 0) {
      parts.push(t("web.turn.tools", { count: data.toolCalls }));
    }
    if (typeof data.durationMs === "number") parts.push(formatMs(data.durationMs));
    if (parts.length) appendTo(feed, el("div", "metric", "⟡ " + parts.join(" · ")));
    // The visible turn-end banner is redundant noise; keep the screen-reader cue.
    announce(t("web.turn.end", { count: data.toolCalls || 0 }));
  }
  const plain = S.turnRoots.map((r) => r.innerText || r.textContent || "").join("\n\n");
  appendActionsRow(feed, plain, S.turnMd);
  resetTurnText();
}

export function resetTurnText() {
  S.turnMd = "";
  S.turnRoots = [];
}

// Per-message copy actions (whole response as plain text / as Markdown).
function copyAction(payload, labelKey) {
  const btn = el("button", "act-btn", t(labelKey));
  btn.type = "button";
  btn.addEventListener("click", () => {
    copyText(payload).then((ok) => {
      btn.textContent = ok ? "✓ " + t("web.code.copied") : "⚠ " + t("web.code.copy_failed");
      window.setTimeout(() => {
        btn.textContent = t(labelKey);
      }, 1400);
    });
  });
  return btn;
}

function appendActionsRow(feed, plain, markdown) {
  const text = String(plain == null ? "" : plain);
  const md = String(markdown == null ? "" : markdown);
  if (!feed || (!text.trim() && !md.trim())) return;
  const bar = el("div", "msg-actions");
  if (text.trim()) bar.appendChild(copyAction(text, "web.msg.copy"));
  if (md.trim()) bar.appendChild(copyAction(md, "web.msg.copy_md"));
  appendTo(feed, bar);
}

export function onErrorEvent(data) {
  if (!data || !data.error) return;
  const feed = feedForEvent(data.sessionId);
  if (feed) appendTo(feed, el("div", "errline", "✗ " + data.error));
  announce(String(data.error));
}

export function onCommandOutput(text, sid) {
  const feed = feedForEvent(sid) || activeFeed();
  if (!feed) return;
  clearEmpty(feed);
  String(text)
    .split("\n")
    .forEach((line) => appendTo(feed, el("div", "cmdout", line)));
}

// Server-forwarded `OutputBus` line (system-prompt overflow, context probe,
// summarization). Text is already redacted server-side; render via
// `textContent` so nothing untrusted is parsed as HTML.
export function onLog(data) {
  if (!data || typeof data.text !== "string" || !data.text) return;
  const feed = feedForEvent(data.sessionId) || activeFeed();
  if (!feed) return;
  const level = data.level;
  const cls = level === "error" ? "errline" : level === "warn" ? "warnline" : "detail";
  const glyph = level === "error" ? "✗ " : level === "warn" ? "⚠ " : "↳ ";
  const line = el("div", cls);
  line.textContent = glyph + data.text;
  appendTo(feed, line);
  if (level === "error" || level === "warn") announce(data.text);
}

// In-loop critic verdict (concern/critical). Mirrors the terminal verbosity
// (quiet hides, normal shows one line, verbose adds the summary). The
// repair/advice directive itself is model-facing and never sent here.
export function onCritic(data) {
  if (!data || (data.status !== "concern" && data.status !== "critical")) return;
  const level = verbosity();
  if (level === "quiet") return;
  const feed = feedForEvent(data.sessionId) || activeFeed();
  if (!feed) return;
  const critical = data.status === "critical" || data.repair === true;
  const label = critical
    ? t("web.critic_repair")
    : pluralCount("web.critic_concern", Number(data.issueCount) || 0);
  const line = el("div", critical ? "warnline" : "detail");
  line.textContent = (critical ? "⚠ " : "⟡ ") + label;
  appendTo(feed, line);
  if (level === "verbose" && typeof data.summary === "string" && data.summary) {
    const detail = el("div", "detail");
    detail.textContent = "↳ " + data.summary;
    appendTo(feed, detail);
  }
  if (critical) announce(label);
}

function renderAssistantText(feed, text) {
  const raw = String(text == null ? "" : text);
  if (!raw.trim()) return;
  const root = renderMarkdown(feed, raw, mdOpts());
  appendActionsRow(feed, root.innerText || root.textContent || "", raw);
}

function renderThinkBlock(feed, text) {
  const { wrap, body } = buildThinkBlock(false);
  body.textContent = text || "";
  feed.appendChild(wrap);
}

function renderHistoryAct(feed, entry, statusNodes) {
  const line = el("div", "act " + categoryOf(entry.name));
  line.appendChild(el("span", "g", "◇"));
  line.appendChild(el("span", "lab", labelOf(entry.name)));
  const args = argText(entry.args);
  if (args) {
    line.appendChild(el("span", "sep", "·"));
    line.appendChild(el("span", "args", args));
  }
  const status = el("span", "ok", "");
  line.appendChild(status);
  feed.appendChild(line);
  if (entry.toolCallId) statusNodes.set(entry.toolCallId, status);
}

function renderHistoryResult(feed, entry, statusNodes) {
  const dur = formatMs(entry.duration);
  const mark = (entry.success ? " ✓" : " ✗") + (dur ? " " + dur : "");
  const status = entry.toolCallId ? statusNodes.get(entry.toolCallId) : null;
  if (status) {
    status.textContent = mark;
    if (!entry.success) status.classList.add("fail");
    statusNodes.delete(entry.toolCallId);
    return;
  }
  const line = el("div", "act " + categoryOf(entry.tool));
  line.appendChild(el("span", "g", "↳"));
  line.appendChild(el("span", "lab", labelOf(entry.tool)));
  line.appendChild(el("span", "ok" + (entry.success ? "" : " fail"), mark));
  feed.appendChild(line);
}

function renderHistory(feed, entries) {
  const statusNodes = new Map();
  entries.forEach((entry) => {
    if (!entry || typeof entry.kind !== "string") return;
    switch (entry.kind) {
      case "user":
        feed.appendChild(el("div", "u", entry.text || ""));
        break;
      case "assistant":
        renderAssistantText(feed, entry.text || "");
        break;
      case "reasoning":
        renderThinkBlock(feed, entry.text || "");
        break;
      case "tool_call":
        renderHistoryAct(feed, entry, statusNodes);
        break;
      case "tool_result":
        renderHistoryResult(feed, entry, statusNodes);
        break;
      case "plan":
        if (entry.text) feed.appendChild(el("div", "sysline", "▸ " + entry.text));
        break;
      case "context":
        if (entry.text) feed.appendChild(el("div", "detail", "↳ " + entry.text));
        break;
      case "error":
        feed.appendChild(el("div", "errline", "✗ " + (entry.text || "")));
        break;
      case "system":
        if (entry.text) feed.appendChild(el("div", "sysline", entry.text));
        break;
    }
  });
}

export function feedHasContent(feed) {
  return !!feed.querySelector(".u, .md, .ans, .code, .act, .think, .metaln, .errline, .sysline");
}

export async function loadHistory(tab) {
  if (!tab || tab.historyLoaded || tab.historyLoading) return;
  tab.historyLoading = true;
  const placeholder = el("div", "detail", t("web.history.loading"));
  if (!feedHasContent(tab.feed)) {
    clearEmpty(tab.feed);
    tab.feed.appendChild(placeholder);
  }
  const r = await api("/api/sessions/" + encodeURIComponent(tab.id) + "/history");
  tab.historyLoading = false;
  placeholder.remove();
  tab.historyLoaded = true;
  if (!r.ok || !r.data || !Array.isArray(r.data.history)) {
    if (!feedHasContent(tab.feed)) tab.feed.appendChild(el("div", "detail", t("web.history.unavailable")));
    return;
  }
  // A live session already rendered its content over SSE: don't duplicate it.
  if (feedHasContent(tab.feed)) return;
  renderHistory(tab.feed, r.data.history);
  if (!r.data.history.length) tab.feed.appendChild(el("div", "detail", t("web.history.empty")));
  if (tab.feed === activeFeed()) scroll();
}

export function syncUrl() {
  const url = new URL(location.href);
  const tab = S.tabs.find((x) => x.id === S.activeTabId);
  if (tab && tab.kind === "session") url.searchParams.set("session", tab.id);
  else url.searchParams.delete("session");
  history.replaceState(null, "", url);
}

// One marking for a plan step, shared by the sidebar (`renderPlan`) and the
// feed card (`onPlan`): status class + leading glyph for done/failed/current.
function planStepMark(step, isCurrent) {
  const status =
    step.status === "done" ? "done" : step.status === "failed" ? "fail" : isCurrent ? "cur" : "";
  const glyph =
    step.status === "done" ? "✓ " : step.status === "failed" ? "✗ " : isCurrent ? "▸ " : "○ ";
  return { status, glyph };
}

export function renderPlan(plan) {
  // The sidebar polls `/api/state` every 2s; skip a rebuild (and the scroll
  // reset it would cause) when the snapshot is unchanged.
  const sig = JSON.stringify([plan, I18N.locale]);
  if (sig === S.lastPlanSig) return;
  S.lastPlanSig = sig;
  planEl.textContent = "";
  if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) {
    planCountEl.textContent = "";
    planEl.appendChild(el("div", "kv dim", t("web.plan.none")));
    return;
  }
  const done = plan.steps.filter((s) => s.status === "done").length;
  const total = plan.steps.length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  planCountEl.textContent = done + " / " + total;
  const bar = el("div", "plan-bar");
  const track = el("span", "pbar");
  const fill = el("i");
  fill.style.width = pct + "%";
  track.appendChild(fill);
  bar.appendChild(track);
  bar.appendChild(el("span", "", pct + "%"));
  planEl.appendChild(bar);
  plan.steps.forEach((step, i) => {
    const current = i === plan.currentIndex && step.status !== "done" && step.status !== "failed";
    const { status, glyph } = planStepMark(step, current);
    planEl.appendChild(el("div", ("plan-step " + status).trim(), glyph + step.text));
  });
}

export function onPlan(data) {
  const feed = feedForEvent(data && data.sessionId);
  if (!feed || !data || !Array.isArray(data.steps) || !data.steps.length) return;
  clearEmpty(feed);
  const tab = S.tabs.find((x) => x.feed === feed);
  let card = tab ? tab.planCard : null;
  if (!card || card.parentNode !== feed) {
    card = el("div", "planblock");
    appendTo(feed, card);
    if (tab) tab.planCard = card;
  }
  card.textContent = "";
  const total = data.steps.length;
  const cur = typeof data.currentIndex === "number" ? data.currentIndex : -1;
  card.appendChild(el("div", "ph2", "◇ " + pluralCount("web.plan.heading", total)));
  data.steps.forEach((step, i) => {
    const { status, glyph } = planStepMark(step, i === cur);
    card.appendChild(el("div", ("st " + status).trim(), glyph + step.text));
  });
  if (feed === activeFeed()) scroll();
}

// `? ` glyph on the last line, matching the terminal menu (the tool may have
// already prefixed it — don't double it).
function questionLabel(text) {
  const lines = String(text).split("\n");
  const last = lines[lines.length - 1];
  if (/^\s*\?/.test(last)) return String(text);
  lines[lines.length - 1] = "? " + last;
  return lines.join("\n");
}

// Answered-state + settle wiring shared by both question kinds. `display` is
// what the user sees; `raw` is exactly what goes to `/api/answer`.
function makeQuestionBlock(feed, promptText, id) {
  const block = el("div", "q");
  block.appendChild(el("div", "qtext", promptText));
  let answered = false;
  const settle = (display, raw) => {
    if (answered) return;
    answered = true;
    block.classList.add("answered");
    block.textContent = "";
    block.appendChild(el("div", "qtext", promptText));
    block.appendChild(el("div", "qans", "↳ " + (String(display || "").trim() || t("web.question.answered"))));
    api("/api/answer", { method: "POST", body: { id, value: raw } });
    if (feed === activeFeed()) scroll();
  };
  return { block, feed, settle, isAnswered: () => answered };
}

// Free-text prompt (a `text` question, or the tool's follow-up after the
// "own answer" choice — see `askUser`/`CUSTOM_INDEX`).
function questionTextInput(q, placeholder) {
  const wrap = el("div", "qcustom");
  const input = el("input", "qinput");
  input.type = "text";
  input.placeholder = placeholder;
  input.setAttribute("aria-label", placeholder);
  input.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      const value = input.value.trim();
      if (value) q.settle(value, value);
    }
  });
  wrap.appendChild(input);
  wrap.appendChild(
    link(t("web.question.custom_send"), "", () => {
      const value = input.value.trim();
      if (value) q.settle(value, value);
    }),
  );
  if (q.feed === activeFeed()) setTimeout(() => input.focus(), 0);
  return wrap;
}

// Choice prompt: single-select settles on click, multi-select collects into a
// send button. The "own answer" entry maps to CUSTOM_INDEX (-1) so the tool
// then asks the free-text follow-up.
function questionChoice(q, data, options) {
  const multiple = !!data.multiple;
  const allowCustom = !!data.allowCustom;
  const entries = options.map((label) => ({ label, raw: null }));
  if (allowCustom) entries.push({ label: t("web.question.custom"), raw: -1 });
  const rawOf = (i) => (entries[i].raw != null ? entries[i].raw : i);
  const opts = el("div", "opts");
  const selected = [];
  let sendBtn = null;
  entries.forEach((entry, i) => {
    const row = el("button", "qopt", i + 1 + ". " + entry.label);
    row.type = "button";
    row.setAttribute("aria-checked", "false");
    row.addEventListener("click", () => {
      if (q.isAnswered()) return;
      if (multiple) {
        const pos = selected.indexOf(i);
        if (pos === -1) {
          selected.push(i);
          row.classList.add("on");
          row.setAttribute("aria-checked", "true");
        } else {
          selected.splice(pos, 1);
          row.classList.remove("on");
          row.setAttribute("aria-checked", "false");
        }
        if (sendBtn) sendBtn.disabled = selected.length === 0;
      } else {
        row.setAttribute("aria-checked", "true");
        q.settle(entry.label, [rawOf(i)]);
      }
    });
    opts.appendChild(row);
  });
  q.block.appendChild(opts);
  if (multiple) {
    q.block.appendChild(el("div", "qmulti-hint", t("web.question.multi_hint")));
    sendBtn = el("button", "qsend", t("web.question.send"));
    sendBtn.type = "button";
    sendBtn.disabled = true;
    sendBtn.addEventListener("click", () => {
      if (q.isAnswered() || !selected.length) return;
      const chosen = selected.slice().sort((a, b) => a - b);
      q.settle(chosen.map((i) => entries[i].label).join(", "), chosen.map(rawOf));
    });
    q.block.appendChild(sendBtn);
  }
}

export function onQuestion(data) {
  if (!data || typeof data.text !== "string") return;
  const feed = feedForEvent(data.sessionId);
  if (!feed) return;
  clearEmpty(feed);
  const q = makeQuestionBlock(feed, questionLabel(data.text), data.id);
  const options = Array.isArray(data.options) ? data.options : [];
  if (data.kind === "choice" && options.length) questionChoice(q, data, options);
  else q.block.appendChild(questionTextInput(q, t("web.question.placeholder")));
  appendTo(feed, q.block);
  if (feed === activeFeed()) scroll();
}

function usageRow(label, value, cls) {
  const row = el("div", "kv");
  row.appendChild(el("span", "", label));
  row.appendChild(el("b", cls || "", value));
  return row;
}

// Session row with a copy button next to the id (icon-only, ✓ on success).
function usageSessionRow(sessionId) {
  const row = el("div", "kv");
  row.appendChild(el("span", "", t("web.usage.session")));
  const val = el("span", "kv-val");
  if (!sessionId) {
    val.appendChild(el("b", "", "—"));
  } else {
    val.appendChild(el("b", "", sessionId));
    const btn = el("button", "copy-btn");
    btn.type = "button";
    btn.title = t("web.usage.copy_id");
    btn.setAttribute("aria-label", t("web.usage.copy_id"));
    btn.appendChild(icon("copy"));
    btn.addEventListener("click", () => {
      copyText(sessionId).then((ok) => {
        btn.replaceChildren(icon(ok ? "check" : "copy"));
        setTimeout(() => btn.replaceChildren(icon("copy")), 1500);
      });
    });
    val.appendChild(btn);
  }
  row.appendChild(val);
  return row;
}

export function renderUsage(h) {
  const cfg = S.state.config || {};
  const sig = JSON.stringify([
    h.sessionId, h.model, h.contextUsed, h.contextLimit, h.cacheHitRate, h.costUsd,
    h.compactionCount, h.contextQuality, h.contextProbe, cfg.model, cfg.contextWindow,
    I18N.locale,
  ]);
  if (sig === S.lastUsageSig) return;
  S.lastUsageSig = sig;
  usageEl.textContent = "";
  const sid = h.sessionId ? String(h.sessionId) : "";
  usageEl.appendChild(usageSessionRow(sid));
  usageEl.appendChild(usageRow(t("web.usage.model"), h.model || cfg.model || "—"));
  const used = typeof h.contextUsed === "number" ? h.contextUsed : null;
  const limit = typeof h.contextLimit === "number" ? h.contextLimit : cfg.contextWindow || null;
  usageEl.appendChild(usageRow(t("web.usage.context"), used != null && limit ? fmtTokens(used) + " / " + fmtTokens(limit) : "—"));
  if (used != null && limit) {
    const bar = el("div", "bar");
    const fill = el("i");
    fill.style.width = Math.min(100, Math.round((used / limit) * 100)) + "%";
    bar.appendChild(fill);
    usageEl.appendChild(bar);
  }
  const hit = typeof h.cacheHitRate === "number" ? h.cacheHitRate : null;
  usageEl.appendChild(usageRow(t("web.usage.cache"), hit != null ? Math.round(hit * 100) + "%" : "—", hit != null ? "" : "dim"));
  usageEl.appendChild(usageRow(t("web.usage.cost"), typeof h.costUsd === "number" ? "$" + h.costUsd.toFixed(4) : "—"));
  usageEl.appendChild(usageRow(t("web.usage.compactions"), "⟳ " + (h.compactionCount || 0), h.compactionCount ? "wn" : "dim"));
  const q = typeof h.contextQuality === "number" ? h.contextQuality : null;
  usageEl.appendChild(usageRow(t("web.usage.quality"), q != null ? Math.round(q) + "%" : "—", q != null ? "" : "dim"));

  // Context probe: real LM Studio loaded context vs configured. Pending/absent
  // renders a dim dash; loaded < configured warns.
  let probeText = "—";
  let probeCls = "dim";
  const probe = h.contextProbe;
  if (probe && typeof probe.actual === "number") {
    const actual = fmtTokens(probe.actual);
    const configured = h.contextLimit || cfg.contextWindow || null;
    if (configured && probe.actual < configured) {
      probeText = t("web.usage.probe_low", { actual, configured: fmtTokens(configured) });
      probeCls = "wn";
    } else {
      probeText = t("web.usage.probe_loaded", { actual });
      probeCls = "";
    }
  }
  usageEl.appendChild(usageRow(t("web.usage.probe"), probeText, probeCls));
}

// Workspace path under the composer (dim, own line).
export function renderWorkspace(h) {
  const ws = h.workspace || "";
  if (wsLine.dataset.ws === ws) return;
  wsLine.dataset.ws = ws;
  wsLine.textContent = "";
  wsLine.hidden = !ws;
  if (!ws) return;
  wsLine.appendChild(el("span", "ws-k", t("web.env.dir")));
  const v = el("span", "ws-v", ws);
  v.title = ws;
  wsLine.appendChild(v);
}

// Environment (sidebar): stacked name/value items — AGENTS.md sources, map size.
function envItem(label, values) {
  const item = el("div", "env-item");
  item.appendChild(el("div", "env-k", label));
  values.forEach((val) => {
    const v = el("div", "env-v", val);
    v.title = val;
    item.appendChild(v);
  });
  return item;
}

export function renderEnvironment(h) {
  const disabled = !!(h.instructions && h.instructions.disabled);
  const files = h.instructions && !disabled ? h.instructions.files || [] : [];
  const map = h.projectMap || null;
  const sig = JSON.stringify([disabled, files, map, I18N.locale]);
  if (sig === S.lastEnvSig) return;
  S.lastEnvSig = sig;
  envEl.textContent = "";
  envEl.appendChild(
    envItem(
      t("web.env.agents"),
      disabled ? [t("web.env.agents_disabled")] : files.length ? files : [t("web.env.agents_none")],
    ),
  );
  envEl.appendChild(
    envItem(
      t("web.env.map"),
      map && map.indexed
        ? [
            [
              pluralCount("web.env.files", map.files),
              pluralCount("web.env.symbols", map.symbols),
              pluralCount("web.env.tokens", map.tokens),
            ].join(" · "),
          ]
        : [t("web.env.map_not_indexed")],
    ),
  );
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

