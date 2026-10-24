// Turn lifecycle handlers: tool start/end, turn end, command output and log.
// Extracted from `feed.js`; `feed.js` re-exports this module's public surface.
import { msgs, el, announce } from "../dom.js";
import { t, pluralCount } from "../i18n.js";
import { streamStateFor, tabs as tabState, session } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { categoryOf, labelOf, argText, formatMs, verbosity } from "../format.js";
import {
  activeFeed, feedForEvent, clearBusy, clearEmpty,
  appendTo, appendActionsRow, flushRun, scrollToBottom,
} from "./core.js";
import { finishMd, finishThink } from "./stream.js";
import { finishToolEnd, appendImageCards } from "./tool-render.js";
import { egressBadge } from "./egress.js";
import { createFace } from "../loader.js";

export function onToolStart(data: Dict): void {
  const feed = feedForEvent(data.sessionId);
  clearBusy(feed);
  if (!feed) return;
  clearEmpty(feed);
  finishMd(feed);
  finishThink(feed);
  const st = streamStateFor(feed);
  st.pendingArgs.set(data.toolCallId, data.args || {});
  const line = el("div", "act " + categoryOf(data.name));
  const isSubagent = data.name === "subagent";
  if (isSubagent) {
    // У субагента вместо глифа — собственный MMART: его состояние ведёт
    // `feed/subagent.ts` по событиям прогона (think/read/create/run/done…).
    const slot = el("span", "srun-face");
    slot.appendChild(createFace("think", "sm"));
    line.appendChild(slot);
  } else {
    line.appendChild(el("span", "g", "◇"));
  }
  line.appendChild(el("span", "lab", labelOf(data.name)));
  if (isSubagent && data.toolCallId != null) {
    // Привязка к прогону появится в SSE `subagent.start`; id нужен и для
    // фолбэка «клик до прихода start» (REST по toolCallId).
    line.dataset.toolCallId = String(data.toolCallId);
  }
  const args = argText(data.args);
  if (args) {
    line.appendChild(el("span", "sep", "·"));
    line.appendChild(el("span", "args", args));
  }
  const status = el("span", "ok", "");
  line.appendChild(status);
  line.classList.add("running");
  appendTo(feed, line);
  st.toolNodes.set(data.toolCallId, { status, line });
  if (categoryOf(data.name) !== "recon") st.runReconOnly = false;
  st.runCount++;
}

export function onToolEnd(data: Dict): void {
  finishToolEnd(data);
  appendImageCards(data);
}

export function onTurnEnd(data: Dict): void {
  // Параллельные сессии: busy снимается, только когда не бежит НИ ОДНА сессия
  // (аудит §6.16) — иначе вкладка другой сессии гасла индикатор.
  session.busy = (session.runningSessionIds || []).length > 0;
  const feed = feedForEvent(data.sessionId);
  clearBusy(feed);
  finishThink(feed);
  finishMd(feed);
  flushRun(feed);
  const st = feed ? streamStateFor(feed) : null;
  // Interrupted tools never get `tool_end`: drop their pulse so nothing
  // looks alive after the turn is over.
  if (st) {
    st.toolNodes.forEach((n) => {
      if (n && n.line && feed && n.line.parentNode === feed) n.line.classList.remove("running");
    });
  }
  const owner = tabState.tabs.find((x) => x.id === data.sessionId);
  if (owner) {
    owner.planCard = null;
    // Ход закончился: живой план снят, сайдбар снова следует за снапшотом.
    owner.livePlan = null;
  }
  if (!feed || !st) {
    resetTurnText(feed);
    return;
  }
  if (data.success === false) {
    const reason =
      data.error || (data.interrupted ? t("web.turn.stopped") : t("web.turn.failed"));
    const cls = data.interrupted ? "warnline" : "errline";
    const glyph = data.interrupted ? "⚠ " : "✗ ";
    appendTo(feed, el("div", cls, glyph + reason));
    announce(reason);
  } else {
    if (data.stopReason) {
      const reason = t("web.turn.stop_" + data.stopReason);
      appendTo(feed, el("div", "warnline", "⚠ " + reason));
      announce(reason);
    }
    const parts: string[] = [];
    if (typeof data.toolCalls === "number" && data.toolCalls > 0) {
      parts.push(pluralCount("web.turn.tools", data.toolCalls));
    }
    if (typeof data.durationMs === "number") parts.push(formatMs(data.durationMs));
    if (parts.length) appendTo(feed, el("div", "metric", "⟡ " + parts.join(" · ")));
    // The visible turn-end banner is redundant noise; keep the screen-reader cue.
    announce(t("web.turn.end", { count: data.toolCalls || 0 }));
  }
  if (data.egress) {
    const badge = egressBadge(data.egress);
    if (badge) appendTo(feed, badge);
  }
  const plain = st.turnRoots.map((r) => r.innerText || r.textContent || "").join("\n\n");
  appendActionsRow(feed, plain, st.turnMd);
  resetTurnText(feed);
}

export function resetTurnText(feed?: HTMLElement | null): void {
  if (!feed) return;
  const st = streamStateFor(feed);
  st.turnMd = "";
  st.turnRoots = [];
}

export function onErrorEvent(data: Dict): void {
  if (!data || !data.error) return;
  const feed = feedForEvent(data.sessionId);
  if (feed) appendTo(feed, el("div", "errline", "✗ " + data.error));
  announce(String(data.error));
}

export function onCommandOutput(text: unknown, sid?: string): void {
  // Слэш-команду можно выполнить и без открытой вкладки (пустой экран): тогда
  // её вывод пишем прямо в контейнер транскрипта, а не теряем в пустоте.
  const feed = feedForEvent(sid) || msgs;
  clearEmpty(feed);
  String(text)
    .split("\n")
    .forEach((line) => appendTo(feed, el("div", "cmdout", line)));
  scrollToBottom();
}

// Server-forwarded `OutputBus` line (system-prompt overflow, context probe,
// summarization). Text is already redacted server-side; render via
// `textContent` so nothing untrusted is parsed as HTML.
export function onLog(data: Dict): void {
  if (!data || typeof data.text !== "string" || !data.text) return;
  // Internal loop diagnostics (retry counters, audit/compaction internals) are
  // session-log material — the chat shows them only in verbose mode.
  if (data.diagnostic && verbosity() !== "verbose") return;
  const feed = feedForEvent(data.sessionId) || activeFeed();
  if (!feed) return;
  const level = data.level;
  const cls = level === "error" ? "errline" : level === "warn" ? "warnline" : "detail";
  const glyph = level === "error" ? "✗ " : level === "warn" ? "⚠ " : "↳ ";
  // A bus line may carry a hint on the next line (STYLE.md: "what — cause" plus
  // one "↳ what to do"). Render the head with the level glyph and the rest as
  // dim detail, so advice never blurs into the warning itself.
  const [head, ...rest] = String(data.text).split("\n");
  const line = el("div", cls);
  line.textContent = glyph + head;
  appendTo(feed, line);
  for (const extra of rest) {
    appendTo(feed, el("div", "detail", extra));
  }
  if (level === "error" || level === "warn") announce(head);
}
