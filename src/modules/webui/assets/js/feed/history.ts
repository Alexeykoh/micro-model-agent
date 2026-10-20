// Session history replay for the feed: `/api/sessions/:id/history` rendering.
// Extracted from `feed.js`; `feed.js` re-exports this module's public surface.
import { el } from "../dom.js";
import { t } from "../i18n.js";
import { categoryOf, labelOf, argText, formatMs } from "../format.js";
import { renderMarkdown } from "../../md.js";
import { api } from "../api.js";
import { imageCard } from "./image-card.js";
import { egressBadge } from "./egress.js";
import type { Dict } from "../core/store/types.js";
import {
  feedHasContent, clearEmpty, scrollToBottom, activeFeed, liveFeed,
  mdOpts, buildThinkBlock, appendActionsRow, userBlock,
} from "./core.js";

function renderAssistantText(feed: HTMLElement, text: unknown): void {
  const raw = String(text == null ? "" : text);
  if (!raw.trim()) return;
  const root = renderMarkdown(feed, raw, mdOpts());
  appendActionsRow(feed, root.innerText || root.textContent || "", raw);
}

function renderThinkBlock(feed: HTMLElement, text: unknown): void {
  const { wrap, body } = buildThinkBlock(false, false);
  body.textContent = text == null ? "" : String(text);
  feed.appendChild(wrap);
}

function renderHistoryAct(
  feed: HTMLElement,
  entry: Dict,
  statusNodes: Map<string, HTMLElement>,
): void {
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

function renderHistoryResult(
  feed: HTMLElement,
  entry: Dict,
  statusNodes: Map<string, HTMLElement>,
): void {
  const dur = formatMs(entry.duration);
  const mark = (entry.success ? " ✓" : " ✗") + (dur ? " " + dur : "");
  const status = entry.toolCallId ? statusNodes.get(entry.toolCallId) : null;
  if (status) {
    status.textContent = mark;
    if (!entry.success) status.classList.add("fail");
    statusNodes.delete(entry.toolCallId);
  } else {
    const line = el("div", "act " + categoryOf(entry.tool));
    line.appendChild(el("span", "g", "↳"));
    line.appendChild(el("span", "lab", labelOf(entry.tool)));
    line.appendChild(el("span", "ok" + (entry.success ? "" : " fail"), mark));
    feed.appendChild(line);
  }
  // Replay сохранённых картинок тула (файл уже может быть вытеснен ротацией —
  // imageCard сам рисует приглушённую пометку по `onerror`).
  if (entry.success && Array.isArray(entry.images) && entry.images.length) {
    for (const url of entry.images) {
      const card = imageCard(String(entry.tool || ""), String(url));
      if (card) feed.appendChild(card);
    }
  }
}

function renderHistory(feed: HTMLElement, entries: Dict[]): void {
  const statusNodes = new Map<string, HTMLElement>();
  entries.forEach((entry) => {
    if (!entry || typeof entry.kind !== "string") return;
    switch (entry.kind) {
      case "user":
        feed.appendChild(userBlock(entry.text || "", entry.images));
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
      case "egress": {
        const badge = egressBadge(entry.egress);
        if (badge) feed.appendChild(badge);
        break;
      }
      case "system":
        if (entry.text) feed.appendChild(el("div", "sysline", entry.text));
        break;
    }
  });
}

export async function loadHistory(tab: Dict): Promise<{ gone: boolean } | undefined> {
  if (!tab || tab.historyLoaded || tab.historyLoading) return { gone: !!tab.dead };
  tab.historyLoading = true;
  const placeholder = el("div", "detail", t("web.history.loading"));
  if (!feedHasContent(tab.feed)) {
    clearEmpty(tab.feed);
    tab.feed.appendChild(placeholder);
  }
  const r = await api<{ history?: Dict[] }>("/api/sessions/" + encodeURIComponent(tab.id) + "/history");
  tab.historyLoading = false;
  placeholder.remove();
  tab.historyLoaded = true;
  tab.historyFailed = false;
  if (!r.ok || !r.data || !Array.isArray(r.data.history)) {
    // 404 — сессии нет на сервере (удалена/подчищена): таб мёртв, ретраи
    // бесполезны, их размечает вызывающий (markTabDead). Остальное —
    // транзиент: одна строка и повтор при следующем открытии.
    if (r.status === 404) return { gone: true };
    tab.historyFailed = true;
    if (!feedHasContent(tab.feed)) tab.feed.appendChild(el("div", "detail", t("web.history.unavailable")));
    return { gone: false };
  }
  // A live session already rendered its content over SSE: don't duplicate it.
  if (feedHasContent(tab.feed)) return;
  renderHistory(tab.feed, r.data.history);
  if (!r.data.history.length) tab.feed.appendChild(el("div", "detail", t("web.history.empty")));
  if (tab.feed === activeFeed()) scrollToBottom();
  else if (tab.feed === liveFeed()) scrollToBottom();
}
