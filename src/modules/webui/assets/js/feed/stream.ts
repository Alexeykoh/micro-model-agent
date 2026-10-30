// Streaming text/reasoning/meta/phase/retract handlers for the feed.
// Extracted from `feed.js`; `feed.js` re-exports this module's public surface.
import { msgs, el, setIcon } from "../dom.js";
import { t } from "../i18n.js";
import { streamStateFor } from "../store.js";
import { verbosity } from "../format.js";
import { mountMarkdown } from "../../md.js";
import {
  activeFeed,
  feedForEvent,
  clearBusy,
  clearEmpty,
  flushRun,
  showBusy,
  appendTo,
  scroll,
  mdOpts,
  buildThinkBlock,
} from "./core.js";
import { buildRetractBlock } from "./retract-block.js";

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
    // Новый ответ — новая цель для отзыва: прошлый уже принят/убран.
    st.lastAnswerRoot = st.curMd.root;
    st.lastAnswerText = "";
  }
  st.curText += chunk;
  st.lastAnswerText += chunk;
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
      if (dur)
        dur.textContent = "· " + ((Date.now() - st.curThink.startedAt) / 1000).toFixed(1) + "s";
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
  // Статус живёт только пока идёт проверка/шаг: иначе «проверяю результат…»
  // копится в ленте на каждом ходу. Показываем одну актуальную строку.
  if (kind === "status" || kind === "progress") clearStatusLines(feed);
  const warn = text.indexOf("⚠") !== -1 || text.indexOf("✗") !== -1;
  const cls = [
    "metaln",
    warn ? "warn" : "",
    kind === "status" || kind === "progress" ? "status" : "",
  ]
    .filter(Boolean)
    .join(" ");
  appendTo(feed, el("div", cls, text));
  if (feed === activeFeed()) scroll();
}

/** Убирает временные статус-строки конкретной ленты (см. `onMeta`). */
export function clearStatusLines(feed?: HTMLElement | null): void {
  if (!feed) return;
  feed.querySelectorAll(".metaln.status").forEach((n) => n.remove());
}

// Гейт забраковал уже отстримленный черновик (SSE `retract`): убираем его
// из ленты до переответа, иначе финал встанет дублем следом
// (ses_munvrcfz_na9ze3). Копипаст хода тоже чистим — отклонённого текста
// в «copy / copy as markdown» быть не должно. Вместо молчаливого исчезновения
// остаётся видимая плашка «кто и почему» (A13): ответ не пропадает бесследно,
// а штатная перепроверка не выглядит ошибкой.
//
// Живой прогон (2026-10-30) показал: к моменту отзыва стриминг уже закрыт —
// статус-строка гейта вызывает `finishMd`, да и `phase: done` приходит раньше.
// Поэтому цель отзыва — `lastAnswerRoot`, а не только открытый `curMd`.
export interface RetractDetails {
  /** Кто отозвал: `critic` | `hallucination` | `audit` (нет у плагинов). */
  source?: string;
  /** Сырой локализованный текст метки (обратная совместимость). */
  label?: string;
  iteration?: number;
  verdict?: string;
}

function retractSourceLabel(source?: string): string {
  if (source === "critic") return t("web.feed.retract_source_critic");
  if (source === "hallucination") return t("web.feed.retract_source_hallucination");
  if (source === "audit") return t("web.feed.retract_source_audit");
  return t("web.feed.retract_source_check");
}

/**
 * Пометка отзыва: свёрнутый блок, как размышления. В ленте видно только
 * «черновик отозван: критик»; причина/вердикт/итерация — за тогглом.
 */
export function retractNote(
  reason: string,
  source?: string,
  meta?: { verdict?: string; iteration?: number },
): HTMLElement {
  return buildRetractBlock(source, reason, meta).wrap;
}

export function onRetract(reason: string, sid?: string, info?: RetractDetails): void {
  const feed = feedForEvent(sid);
  if (!feed) return;
  clearBusy(feed);
  const st = streamStateFor(feed);
  // Открытый сегмент важнее закрытого: если ответ ещё стримится, режем его.
  const draftRoot = st.curMd ? st.curMd.root : st.lastAnswerRoot;
  const draftLen = st.curMd && st.curText ? st.curText.length : st.lastAnswerText.length;
  finishMd(feed);
  finishThink(feed);
  if (draftRoot) {
    const idx = st.turnRoots.indexOf(draftRoot);
    if (idx !== -1) st.turnRoots.splice(idx, 1);
    draftRoot.remove();
  }
  if (draftLen > 0) st.turnMd = st.turnMd.slice(0, Math.max(0, st.turnMd.length - draftLen));
  st.lastAnswerRoot = null;
  st.lastAnswerText = "";
  clearStatusLines(feed);
  appendTo(
    feed,
    retractNote(reason, info?.source, {
      verdict: info?.verdict,
      iteration: info?.iteration,
    }),
  );
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
  if (tog)
    setIcon(
      tog as HTMLElement,
      hidden ? "chevron-right" : "chevron-down",
      t(hidden ? "web.action.show" : "web.action.hide"),
    );
});
