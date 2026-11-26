// Streaming text/reasoning/meta/phase/retract handlers for the feed.
// Extracted from `feed.js`; `feed.js` re-exports this module's public surface.
import { msgs, el, setIcon } from "../dom.js";
import { t } from "../i18n.js";
import { streamStateFor } from "../store.js";
import { verbosity } from "../format.js";
import { formatDuration } from "../duration.js";
import { mountMarkdown } from "../../md.js";
import {
  activeFeed,
  feedForEvent,
  clearEmpty,
  appendTo,
  scroll,
  mdOpts,
  buildThinkBlock,
} from "./core.js";
import { clearBusy, flushRun, showBusy } from "./busy.js";
import { buildRetractBlock } from "./retract-block.js";
import type { ThinkState } from "../core/store/types.js";

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
// `final` — ответ закрыт самым ходом (`onTurnEnd`): только ему положены рейка
// и фон. Всё, что закрылось по ходу работы (инструмент, размышление, статус,
// критик), — промежуточный ответ: он остаётся «голым», без белой полосы слева.
// Класс `streaming` при этом снимается, чтобы не мигал курсор у готового текста.
export function finishMd(feed?: HTMLElement | null, final = false): void {
  if (!feed) return;
  const st = streamStateFor(feed);
  flushText(feed);
  if (st.curMd) {
    st.curMd.root.classList.remove("streaming");
    if (!final) st.curMd.root.classList.add("interim");
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

/** Header text for a think block: duration only (tok/s lives in the footer chip). */
export function thinkDurText(startedAt: number, now = Date.now()): string {
  return `· ${formatDuration(now - startedAt)}`;
}

function updateThinkHeader(feed: HTMLElement): void {
  const st = streamStateFor(feed);
  if (!st.curThink) return;
  if (!st.curThink.wrap.isConnected) {
    if (st.curThink.timer) {
      clearInterval(st.curThink.timer);
      st.curThink.timer = undefined;
    }
    return;
  }
  const dur = st.curThink.head.querySelector(".dur");
  if (dur) dur.textContent = thinkDurText(st.curThink.startedAt, Date.now());
}

export function finishThink(feed?: HTMLElement | null): void {
  if (!feed) return;
  const st = streamStateFor(feed);
  if (st.curThink) {
    if (st.curThink.timer) {
      clearInterval(st.curThink.timer);
      st.curThink.timer = undefined;
    }
    if (st.curThink.wrap) st.curThink.wrap.classList.remove("live");
    const dur = st.curThink.head.querySelector(".dur");
    if (dur) dur.textContent = thinkDurText(st.curThink.startedAt, Date.now());
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
    // Thinking belongs INSIDE the step group: it folds together with the tools
    // that follow, so no `flushRun` here (the group closes on text/turn end).
    const { wrap, head, body } = buildThinkBlock(true, undefined, info);
    // `appendTo` fires `hooks.afterFeedAppend`, which folds the row immediately.
    appendTo(feed, wrap);
    const think: ThinkState = { wrap, head, body, startedAt: Date.now(), chars: 0, timer: undefined };
    st.curThink = think;
    // Live tick: пока модель думает, заголовок показывает растущие секунды и
    // оценку т/с (пользователь видит, что процесс идёт).
    think.timer = setInterval(() => updateThinkHeader(feed), 250);
  }
  const think = st.curThink;
  if (think) {
    think.chars = (think.chars ?? 0) + chunk.length;
    think.body.textContent += chunk;
  }
  updateThinkHeader(feed);
  if (feed === activeFeed()) scroll();
}

// Generic agent status (context stats, compaction, warnings):
// always visible, one dim line per chunk, never collapsed. Tool bodies
// (`kind: "tool"` — display/output/diff/failure-gist from ToolBatch) are
// model-facing and hidden in quiet mode, mirroring the terminal renderer
// (`BodyStream.write`). In non-quiet modes THIS is the only place the body is
// drawn: `tool_end` closes the action line with its status and never opens a
// second `.toolout` box (the old onMeta + toolout duplication in normal/verbose).
// Failures still surface once in quiet via `tool_end` ↳ first output line.
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
// built by `buildThinkBlock`). Экспортирован отдельно от слушателя: в тестовом
// процессе общий модульный кэш, а `document`/`#msgs` подменяются между файлами,
// поэтому delegated-клику нельзя доверять в DOM-тестах — зовём логику напрямую.
export function toggleThinkHead(head: HTMLElement): void {
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
}

// `?.` — как в feed/core: `#msgs` может отсутствовать на момент оценки.
msgs?.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const head = target.closest(".think-h");
  if (head) toggleThinkHead(head as HTMLElement);
});
