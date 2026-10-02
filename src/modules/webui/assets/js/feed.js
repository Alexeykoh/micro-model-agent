// Feed, turn-stream handlers, history, question UI and sidebar renders.
// All SSE `on*` handlers live here; `app.js` only wires them to EventSource.
import { mountMarkdown, copyText } from "../md.js";
import {
msgs, el, icon, setIcon, announce,
} from "./dom.js";
import { t, pluralCount } from "./i18n.js";
import { S } from "./store.js";
import {
FILE_TOOLS, OPENABLE_TOOLS, IMAGE_TOOLS, LINK_TOOLS,
categoryOf, labelOf, argText, formatMs, verbosity, firstOutputLine,
} from "./format.js";
import {
  activeFeed, liveFeed, feedForEvent, clearBusy, clearEmpty, flushRun,
  appendTo, scroll, showBusy, insertAfter,
  mdOpts, buildThinkBlock, appendActionsRow,
} from "./feed/core.js";
export * from "./feed/core.js";
export * from "./feed/sidebar.js";
export * from "./feed/history.js";
export * from "./feed/plan.js";
export * from "./feed/question.js";


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
  line.classList.add("running");
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

// File rows are always expanded: one `filerow` per file-tool call, no
// collapsing group. Consecutive rows stay a plain expanded list (the old
// E grouping with a chevron toggle hid the list and failed to open).
function displayPathFromRoot(path) {
  const raw = String(path == null ? "" : path).replace(/\\/g, "/");
  try {
    const ws = S && S.state && S.state.host && S.state.host.workspace
      ? String(S.state.host.workspace).replace(/\\/g, "/").replace(/\/+$/, "")
      : "";
    if (ws && (raw === ws || raw.indexOf(ws + "/") === 0)) {
      const rel = raw === ws ? "" : raw.slice(ws.length + 1);
      if (rel) return rel;
    }
  } catch (err) {
    /* fail-open: show raw path */
  }
  return raw;
}

function cardFor(name, args, sid, ok) {
  const feed = feedForEvent(sid);
  if (!feed) return null;
  if (FILE_TOOLS.indexOf(name) !== -1) {
    const path = args.path || args.file || args.dir;
    if (!path) return null;
    const shown = displayPathFromRoot(path);
    const row = el("div", "filerow " + categoryOf(name));
    row.appendChild(el("span", "g", "◇"));
    row.appendChild(el("span", "lab", labelOf(name)));
    row.appendChild(el("span", "sep", " · "));
    if (OPENABLE_TOOLS.indexOf(name) !== -1) {
      const openLink = el("a", "path", shown || String(path));
      openLink.href = "/api/file?path=" + encodeURIComponent(String(path));
      openLink.target = "_blank";
      openLink.rel = "noopener noreferrer";
      openLink.title = t("web.card.open_title") + " · " + String(path);
      row.appendChild(openLink);
    } else {
      const s = el("span", "tail", shown || String(path));
      s.title = String(path);
      row.appendChild(s);
    }
    const copyBtn = el("button", "copy-btn");
    copyBtn.type = "button";
    copyBtn.title = t("web.card.copy_title");
    copyBtn.setAttribute("aria-label", t("web.card.copy_title"));
    copyBtn.appendChild(icon("copy"));
    copyBtn.addEventListener("click", () => {
      copyText(String(path)).then((ok) => {
        copyBtn.replaceChildren(icon(ok ? "check" : "copy"));
        if (!ok) { const st = row.querySelector(".st"); if (st) st.textContent = " ⚠"; }
        window.setTimeout(() => copyBtn.replaceChildren(icon("copy")), 1400);
      });
    });
    row.appendChild(copyBtn);
    row.appendChild(el("span", "st", ok === false ? " ✗" : ok === true ? " ✓" : ""));
    if (ok === false) row.dataset.fail = "1";
    if (/\.drawio(\.xml)?$/i.test(String(path)) && verbosity() === "verbose") {
      row.appendChild(el("span", "detail", "↳ " + t("web.card.drawio_hint")));
    }
    appendTo(feed, row);
    return row;
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
    node.line.classList.remove("running");
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
  // File tools render as a single filerow (viewer link + copy): the `.act`
  // line from `onToolStart` is replaced, otherwise the feed shows the same
  // action twice (act + filerow). Without a path `cardFor` renders nothing,
  // so keep the generic act line in that case.
  const filePath = args.path || args.file || args.dir;
  if (FILE_TOOLS.indexOf(data.name) !== -1 && filePath) {
    if (line && line.parentNode) line.remove();
    if (verbosity() === "quiet") {
      if (data.success) {
        const card = cardFor(data.name, args, data.sessionId, data.success);
        if (card) S.runNodes.push(card);
        S.runDuration += typeof data.durationMs === "number" ? data.durationMs : 0;
      } else {
        const card = cardFor(data.name, args, data.sessionId, data.success);
        const cause = firstOutputLine(data.output);
        if (cause) insertAfter(card || line, el("div", "detail", "↳ " + cause));
        if (card) S.runNodes.push(card);
      }
      return;
    }
    const card = cardFor(data.name, args, data.sessionId, data.success);
    renderToolOutput(card || line, data.output);
    return;
  }
  if (verbosity() === "quiet") {
    // Quiet hides tool bodies. Track successful nodes so a run of read-only
    // actions can fold at the next segment; a failure keeps its line and adds
    // a single `↳` cause instead of the whole model-facing body.
    if (data.success) {
      if (line) S.runNodes.push(line);
      const card = cardFor(data.name, args, data.sessionId, data.success);
      if (card) S.runNodes.push(card);
      S.runDuration += typeof data.durationMs === "number" ? data.durationMs : 0;
    } else {
      const cause = firstOutputLine(data.output);
      if (cause) insertAfter(line, el("div", "detail", "↳ " + cause));
    }
    return;
  }
  if (data.success) cardFor(data.name, args, data.sessionId, data.success);
  renderToolOutput(line, data.output);
}

export function onTurnEnd(data) {
  S.state.busy = false;
  const feed = feedForEvent(data.sessionId);
  clearBusy(feed);
  finishThink();
  finishMd();
  flushRun();
  // Interrupted tools never get `tool_end`: drop their pulse so nothing
  // looks alive after the turn is over.
  S.toolNodes.forEach((n) => {
    if (n && n.line && feed && n.line.parentNode === feed) n.line.classList.remove("running");
  });
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
  // Internal loop diagnostics (retry counters, audit/compaction internals) are
  // session-log material — the chat shows them only in verbose mode.
  if (data.diagnostic && verbosity() !== "verbose") return;
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

