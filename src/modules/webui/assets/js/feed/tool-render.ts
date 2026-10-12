// Rendering of tool results: file rows, tool output bodies, link lines and
// image cards — вынесено из `feed/turn.ts` (правило ≤300).
import { el, icon } from "../dom.js";
import { t, pluralCount } from "../i18n.js";
import { streamStateFor, session } from "../store.js";
import type { Dict } from "../core/store/types.js";
import {
  FILE_TOOLS, OPENABLE_TOOLS, LINK_TOOLS,
  categoryOf, labelOf, formatMs, verbosity, firstOutputLine,
} from "../format.js";
import { copyText } from "../../md.js";
import { imageCard } from "./image-card.js";
import { feedForEvent, appendTo, insertAfter, liveFeed } from "./core.js";

function renderToolOutput(line: HTMLElement | null, text: unknown): void {
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

function safeUrl(url: unknown): string | null {
  if (typeof url !== "string" || !url) return null;
  try {
    const u = new URL(url, location.href);
    if (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "file:") {
      return u.href;
    }
  } catch {
    return null;
  }
  return null;
}

// File rows are always expanded: one `filerow` per file-tool call, no
// collapsing group.
function displayPathFromRoot(path: unknown): string {
  const raw = String(path == null ? "" : path).replace(/\\/g, "/");
  try {
    const ws = session && session.host && session.host.workspace
      ? String(session.host.workspace).replace(/\\/g, "/").replace(/\/+$/, "")
      : "";
    if (ws && (raw === ws || raw.indexOf(ws + "/") === 0)) {
      const rel = raw === ws ? "" : raw.slice(ws.length + 1);
      if (rel) return rel;
    }
  } catch {
    /* fail-open: show raw path */
  }
  return raw;
}

function cardFor(name: string, args: Dict, sid: string | undefined, ok: boolean): HTMLElement | null {
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
      copyText(String(path)).then((ok: boolean) => {
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
      } catch {
        /* no hostname */
      }
    } else {
      line.appendChild(el("span", "", args.url));
    }
    appendTo(feed, line);
    return line;
  }
  // Картинки тулов (browser/attach_image) рисуются в `onToolEnd` по данным
  // `tool_end.images` — здесь, на старте, никаких заглушек-обещаний.
  return null;
}

// Реальные картинки тулов приходят в `tool_end.images` (URL дискового файла
// либо inline data URL). Рисуем миниатюры после тела тула.
export function appendImageCards(data: Dict): void {
  if (!data.success || !Array.isArray(data.images) || !data.images.length) return;
  const feed = feedForEvent(data.sessionId);
  if (!feed) return;
  for (const url of data.images) {
    const card = imageCard(String(data.name || ""), String(url));
    if (card) appendTo(feed, card);
  }
}

export function finishToolEnd(data: Dict): void {
  const feed = feedForEvent(data.sessionId);
  const st = feed ? streamStateFor(feed) : null;
  const node = st ? st.toolNodes.get(data.toolCallId) : undefined;
  const line = node ? node.line : null;
  if (node && st) {
    node.line.classList.remove("running");
    const dur = formatMs(data.durationMs);
    node.status.textContent = data.success ? " ✓" + (dur ? " " + dur : "") : " ✗" + (dur ? " " + dur : "");
    if (!data.success) {
      node.status.classList.add("fail");
      st.runFails++;
      st.runReconOnly = false;
    }
    st.toolNodes.delete(data.toolCallId);
  }
  const args = (st ? st.pendingArgs.get(data.toolCallId) : undefined) || {};
  if (st) st.pendingArgs.delete(data.toolCallId);
  // File tools render as a single filerow (viewer link + copy): the `.act`
  // line from `onToolStart` is replaced, otherwise the feed shows the same
  // action twice (act + filerow).
  const filePath = args.path || args.file || args.dir;
  if (FILE_TOOLS.indexOf(data.name) !== -1 && filePath) {
    if (line && line.parentNode) line.remove();
    if (verbosity() === "quiet") {
      if (data.success) {
        const card = cardFor(data.name, args, data.sessionId, data.success);
        if (card && st) st.runNodes.push(card);
        if (st) st.runDuration += typeof data.durationMs === "number" ? data.durationMs : 0;
      } else {
        const card = cardFor(data.name, args, data.sessionId, data.success);
        const cause = firstOutputLine(data.output);
        if (cause) insertAfter(card || line, el("div", "detail", "↳ " + cause));
        if (card && st) st.runNodes.push(card);
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
      if (line && st) st.runNodes.push(line);
      const card = cardFor(data.name, args, data.sessionId, data.success);
      if (card && st) st.runNodes.push(card);
      if (st) st.runDuration += typeof data.durationMs === "number" ? data.durationMs : 0;
    } else {
      const cause = firstOutputLine(data.output);
      if (cause) insertAfter(line, el("div", "detail", "↳ " + cause));
    }
    return;
  }
  if (data.success) cardFor(data.name, args, data.sessionId, data.success);
  renderToolOutput(line, data.output);
}
