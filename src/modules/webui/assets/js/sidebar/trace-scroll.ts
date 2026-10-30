// Scroll contract for the reversed Trace list: fresh rows sit on top, so the
// "live edge" is `scrollTop = 0`. The reader is followed only while they sit at
// that edge; once they dive into history a `↑ latest` pill appears and the list
// is left alone.
//
// Row updates are batched per animation frame: a streamed answer yields one
// layout + at most one scroll per frame instead of one per token.
import { t } from "../i18n.js";
import { sb } from "./state.js";

/** Насколько близко к нулю считается «у свежей кромки» (px). */
export const TRACE_EDGE_PX = 4;

let topBtn: HTMLButtonElement | null = null;
let boundBtn: HTMLButtonElement | null = null;
let boundList: HTMLElement | null = null;
let frame: number | null = null;
let pending: Array<() => void> = [];
let followWanted = false;

function raf(): boolean {
  return typeof requestAnimationFrame === "function" && typeof cancelAnimationFrame === "function";
}

/** True, когда читатель у свежей (верхней) кромки перевёрнутой ленты. */
export function traceAtFreshEdge(): boolean {
  const list = sb.listEl;
  return !list || list.scrollTop <= TRACE_EDGE_PX;
}

/** Показать/скрыть кнопку «к свежим»; вызывается и по scroll-событию. */
export function syncTraceTopBtn(): void {
  if (!topBtn) return;
  topBtn.hidden = traceAtFreshEdge();
}

/** Вернуться к свежим строкам (верх перевёрнутой ленты). */
export function traceToFresh(): void {
  const list = sb.listEl;
  if (list) list.scrollTop = 0;
  syncTraceTopBtn();
}

/** Подписи кнопки — отдельно от init, чтобы смена языка не требовала реинита. */
export function traceScrollI18n(): void {
  if (!topBtn) return;
  const label = t("web.sidebar.trace_latest");
  topBtn.textContent = label;
  topBtn.title = label;
  topBtn.setAttribute("aria-label", label);
}

/**
 * Приклеиться к свежей кромке, если читатель был у неё в момент события.
 * Решение принимается до вставки узлов: при чтении истории позиция не трогается.
 */
export function traceFollow(pinned: boolean): void {
  if (pinned) followWanted = true;
  scheduleFlush();
}

/** Поставить работу в очередь одного кадра (без rAF — сразу, для тестов/SSR). */
export function scheduleTrace(work: () => void): void {
  pending.push(work);
  scheduleFlush();
}

function scheduleFlush(): void {
  if (frame !== null) return;
  if (!raf()) {
    flushTraceFrame();
    return;
  }
  frame = requestAnimationFrame(() => {
    frame = null;
    flushTraceFrame();
  });
}

/** Выполнить накопленное сейчас (кадр, тест, смена сессии). Один скролл на пачку. */
export function flushTraceFrame(): void {
  if (frame !== null) {
    if (raf()) cancelAnimationFrame(frame);
    frame = null;
  }
  const work = pending;
  pending = [];
  for (const fn of work) fn();
  const list = sb.listEl;
  if (followWanted && list) list.scrollTop = 0;
  followWanted = false;
  syncTraceTopBtn();
}

/** Сброс при ребилде списка/смене сессии: очередь и позиция начинаются заново. */
export function resetTraceScroll(): void {
  pending = [];
  followWanted = false;
  if (frame !== null) {
    if (raf()) cancelAnimationFrame(frame);
    frame = null;
  }
  const list = sb.listEl;
  if (list) list.scrollTop = 0;
  syncTraceTopBtn();
}

/** Монтирует кнопку «к свежим» и scroll-наблюдатель. Идемпотентно. */
export function initTraceScroll(): void {
  topBtn = document.getElementById("traceTopBtn") as HTMLButtonElement | null;
  if (topBtn && topBtn !== boundBtn) {
    // `hidden` снимается только scroll-обработчиком: при пустой ленте кнопка
    // молчит и не отнимает место у «Prompt».
    topBtn.hidden = true;
    topBtn.addEventListener("click", traceToFresh);
    boundBtn = topBtn;
  }
  const list = sb.listEl;
  if (list && list !== boundList) {
    list.addEventListener("scroll", syncTraceTopBtn, { passive: true });
    boundList = list;
  }
  if (topBtn) traceScrollI18n();
  syncTraceTopBtn();
}
