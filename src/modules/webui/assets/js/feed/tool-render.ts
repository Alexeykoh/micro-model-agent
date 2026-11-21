// Rendering of tool result cards: file rows, link lines and image cards —
// вынесено из `feed/turn.ts` (правило ≤300). Тело тула рисует ОДИН канал —
// `meta(kind:"tool")` в `feed/stream.ts` (паритет с терминальным
// `BodyStream.write`); `tool_end` только закрывает строку действия статусом.
import { el, icon } from "../dom.js";
import { t } from "../i18n.js";
import { streamStateFor, session, hooks } from "../store.js";
import type { Dict } from "../core/store/types.js";
import {
  FILE_TOOLS, OPENABLE_TOOLS, LINK_TOOLS,
  categoryOf, labelOf, formatMs, verbosity, firstOutputLine, hiddenText, isHiddenText, readRangeText,
} from "../format.js";
import { copyText } from "../../md.js";
import { imageCard } from "./image-card.js";
import { feedForEvent, appendTo, insertAfter } from "./core.js";

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
    const rawPath = String(path);
    // Внешнему клиенту путь приходит псевдонимом: ссылка на файл всё равно
    // не сработает, поэтому показываем маркер вместо битого URL.
    const hidden = isHiddenText(rawPath);
    const shown = hidden ? hiddenText(rawPath) : displayPathFromRoot(path);
    const row = el("div", "filerow " + categoryOf(name));
    row.appendChild(el("span", "g", "◇"));
    row.appendChild(el("span", "lab", labelOf(name)));
    row.appendChild(el("span", "sep", " · "));
    if (OPENABLE_TOOLS.indexOf(name) !== -1 && !hidden) {
      const openLink = el("a", "path", shown || rawPath);
      openLink.href = "/api/file?path=" + encodeURIComponent(rawPath);
      openLink.target = "_blank";
      openLink.rel = "noopener noreferrer";
      openLink.title = t("web.card.open_title") + " · " + rawPath;
      // Left click opens the Files tab with the tree revealed to the file (the
      // hook is registered by app.js); modifiers / middle-click keep the raw
      // preview in a new browser tab as a fallback.
      openLink.addEventListener("click", (ev) => {
        const open = hooks.openFileInTree;
        if (!open) return;
        if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) {
          return;
        }
        ev.preventDefault();
        open(String(path));
      });
      row.appendChild(openLink);
    } else {
      // DLP marker: a gray Lucide lock instead of the long "hidden by data
      // policy" phrase, with the explanation as the tooltip.
      const s = el("span", "tail" + (hidden ? " dlp-lock" : ""), hidden ? "" : shown || rawPath);
      if (hidden) s.appendChild(icon("lock"));
      s.title = hidden ? t("web.egress.hidden_tip") : rawPath;
      if (hidden) s.setAttribute("aria-label", t("web.egress.hidden_tip"));
      row.appendChild(s);
    }
    const range = readRangeText(name, args);
    if (range) {
      row.appendChild(el("span", "sep", " · "));
      const r = el("span", "tail range", range);
      r.title = t("web.tool.lines_title");
      row.appendChild(r);
    }
    const copyBtn = el("button", "copy-btn");
    copyBtn.type = "button";
    copyBtn.title = t("web.card.copy_title");
    copyBtn.setAttribute("aria-label", t("web.card.copy_title"));
    copyBtn.appendChild(icon("copy"));
    copyBtn.addEventListener("click", () => {
      copyText(rawPath).then((ok: boolean) => {
        copyBtn.replaceChildren(icon(ok ? "check" : "copy"));
        if (!ok) { const st = row.querySelector(".st"); if (st) st.textContent = " ⚠"; }
        window.setTimeout(() => copyBtn.replaceChildren(icon("copy")), 1400);
      });
    });
    row.appendChild(copyBtn);
    row.appendChild(el("span", "st", ok === false ? " ✗" : ok === true ? " ✓" : ""));
    if (ok === false) row.dataset.fail = "1";
    if (/\.drawio(\.xml)?$/i.test(rawPath) && verbosity() === "verbose") {
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
    // Тело уже нарисовано `meta(kind:"tool")` — здесь только карточка файла.
    cardFor(data.name, args, data.sessionId, data.success);
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
}
