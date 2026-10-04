// Turn lifecycle handlers: tool start/end, turn end, command output and log.
// Extracted from `feed.js`; `feed.js` re-exports this module's public surface.
import { el, icon, announce } from "../dom.js";
import { t, pluralCount } from "../i18n.js";
import { feed as feedState, tabs as tabState, session } from "../store.js";
import {
  FILE_TOOLS, OPENABLE_TOOLS, IMAGE_TOOLS, LINK_TOOLS,
  categoryOf, labelOf, argText, formatMs, verbosity, firstOutputLine,
} from "../format.js";
import { copyText } from "../../md.js";
import {
  activeFeed, liveFeed, feedForEvent, clearBusy, clearEmpty,
  appendTo, insertAfter, appendActionsRow, flushRun,
} from "./core.js";
import { finishMd, finishThink } from "./stream.js";

export function onToolStart(data) {
  const feed = feedForEvent(data.sessionId);
  clearBusy(feed);
  if (!feed) return;
  clearEmpty(feed);
  finishMd();
  finishThink();
  feedState.pendingArgs.set(data.toolCallId, data.args || {});
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
  feedState.toolNodes.set(data.toolCallId, { status, line });
  if (categoryOf(data.name) !== "recon") feedState.runReconOnly = false;
  feedState.runCount++;
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
    const ws = session && session.host && session.host.workspace
      ? String(session.host.workspace).replace(/\\/g, "/").replace(/\/+$/, "")
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
  const node = feedState.toolNodes.get(data.toolCallId);
  const line = node ? node.line : null;
  if (node) {
    node.line.classList.remove("running");
    const dur = formatMs(data.durationMs);
    node.status.textContent = data.success ? " ✓" + (dur ? " " + dur : "") : " ✗" + (dur ? " " + dur : "");
    if (!data.success) {
      node.status.classList.add("fail");
      feedState.runFails++;
      feedState.runReconOnly = false;
    }
  }
  feedState.toolNodes.delete(data.toolCallId);
  const args = feedState.pendingArgs.get(data.toolCallId) || {};
  feedState.pendingArgs.delete(data.toolCallId);
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
        if (card) feedState.runNodes.push(card);
        feedState.runDuration += typeof data.durationMs === "number" ? data.durationMs : 0;
      } else {
        const card = cardFor(data.name, args, data.sessionId, data.success);
        const cause = firstOutputLine(data.output);
        if (cause) insertAfter(card || line, el("div", "detail", "↳ " + cause));
        if (card) feedState.runNodes.push(card);
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
      if (line) feedState.runNodes.push(line);
      const card = cardFor(data.name, args, data.sessionId, data.success);
      if (card) feedState.runNodes.push(card);
      feedState.runDuration += typeof data.durationMs === "number" ? data.durationMs : 0;
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
  session.busy = false;
  const feed = feedForEvent(data.sessionId);
  clearBusy(feed);
  finishThink();
  finishMd();
  flushRun();
  // Interrupted tools never get `tool_end`: drop their pulse so nothing
  // looks alive after the turn is over.
  feedState.toolNodes.forEach((n) => {
    if (n && n.line && feed && n.line.parentNode === feed) n.line.classList.remove("running");
  });
  const owner = tabState.tabs.find((x) => x.id === data.sessionId);
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
  const plain = feedState.turnRoots.map((r) => r.innerText || r.textContent || "").join("\n\n");
  appendActionsRow(feed, plain, feedState.turnMd);
  resetTurnText();
}

export function resetTurnText() {
  feedState.turnMd = "";
  feedState.turnRoots = [];
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
