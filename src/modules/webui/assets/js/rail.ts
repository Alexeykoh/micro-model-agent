// Activity rail — the indicator above the composer for the whole `busy` period.
//
// The in-feed `.busy` line clears on the first `text` event; the rail lives
// until the turn ends and shows only what we actually know: phase, elapsed,
// plan progress when a plan exists, tool/event counters. Without a plan
// the rail is an indeterminate scanner — no invented percentages.
// Layouts: off | line (default) | meta | full — see docs/specs/2026-09-27-activity-rail-design.md.

import { t, pluralCount } from "./i18n.js";
import { labelOf } from "./format.js";
import { session } from "./store.js";
import { resetSpeed } from "./speed.js";
import { renderLiveSpeed } from "./feed/speed-chip.js";
import {
  activityLabel,
  activityPhase,
  activitySubscribeAll,
  activityTimeText,
} from "./core/activity.js";
import type { Dict } from "./core/store/types.js";

const LAYOUTS = ["off", "line", "meta", "full"];

let root: HTMLElement | null = null;
let trackEl: HTMLElement | null = null;
let fillEl: HTMLElement | null = null;
let notchesEl: HTMLElement | null = null;
let labEl: HTMLElement | null = null;
let timeEl: HTMLElement | null = null;
let stepsEl: HTMLElement | null = null;
let escEl: HTMLElement | null = null;
let toolsEl: HTMLElement | null = null;
let eventsEl: HTMLElement | null = null;
let lastEl: HTMLElement | null = null;
let lastSepEl: HTMLElement | null = null;
let layout = "line";
let busy = false;

/**
 * Счётчики и план — по сессиям. Рельс один на окно и рисует только активную
 * вкладку; фоновая работа копится в своей записи (и появится при возврате),
 * но чужие числа на экран не попадают.
 */
interface RailSession {
  tools: number;
  events: number;
  lastTool: string;
  plan: Dict | null;
}
const railSessions = new Map<string, RailSession>();

function railSession(key: string): RailSession {
  let st = railSessions.get(key);
  if (!st) {
    st = { tools: 0, events: 0, lastTool: "", plan: null };
    railSessions.set(key, st);
  }
  return st;
}
// biome-ignore lint/suspicious/noExplicitAny: opaque timer handle.
let timer: any = null;
let unsubActivity: (() => void) | null = null;
let notchesFor = 0;

// Step boundaries are drawn from the real plan length: a single notch sits on
// every boundary (total - 1 of them), so 5 steps always yield 4 dividers.
function renderNotches(total: number): void {
  if (!notchesEl || total === notchesFor) return;
  notchesFor = total;
  notchesEl.textContent = "";
  for (let i = 1; i < total; i++) {
    const mark = document.createElement("i");
    mark.style.left = ((i / total) * 100).toFixed(3) + "%";
    notchesEl.appendChild(mark);
  }
}

/**
 * Чью работу показывает рельс. Он один на окно, а ходы могут идти
 * параллельно — значит только активная вкладка. Фолбэк «последняя активная
 * сессия» показывал «думаю» чужого чата в свежем (аудит многозадачности).
 */
function railKey(): string {
  return session.activeSessionId || "";
}

function render(): void {
  if (
    !root ||
    !labEl ||
    !timeEl ||
    !trackEl ||
    !fillEl ||
    !stepsEl ||
    !toolsEl ||
    !eventsEl ||
    !lastEl ||
    !escEl
  ) {
    return;
  }
  const key = railKey();
  root.hidden = layout === "off" || !busy || !key;
  if (root.hidden) return;
  const st = railSession(key);
  const phase = activityPhase(key);
  root.classList.toggle("phase-tool", phase === "tool");
  root.classList.toggle("phase-compose", phase === "composing");
  labEl.textContent = "✦ " + activityLabel(key);
  timeEl.textContent = activityTimeText(key);
  // Live tok/s живёт только в чипе футера (без дубля в рельсе).
  renderLiveSpeed(key);
  const steps = st.plan && Array.isArray(st.plan.steps) ? st.plan.steps : [];
  if (steps.length > 0) {
    const done = steps.filter((s: Dict) => s && s.status === "done").length;
    trackEl.dataset.mode = "plan";
    renderNotches(steps.length);
    fillEl.style.setProperty("--prog", String((done / steps.length) * 100));
    stepsEl.textContent = t("web.rail.step_of", {
      cur: Math.min(done + 1, steps.length),
      total: steps.length,
    });
  } else {
    trackEl.dataset.mode = "scan";
    stepsEl.textContent = t("web.rail.no_plan");
  }
  toolsEl.textContent = pluralCount("web.rail.tools", st.tools);
  eventsEl.textContent = pluralCount("web.rail.events", st.events);
  // Без последнего тула не оставляем висящий разделитель и «—»: строка короче.
  if (lastSepEl) lastSepEl.hidden = !st.lastTool;
  lastEl.hidden = !st.lastTool;
  lastEl.textContent = st.lastTool ? t("web.rail.last") + " " + st.lastTool : "";
  escEl.textContent = t("web.input.esc");
}

function flash(): void {
  if (!trackEl || !busy) return;
  trackEl.classList.remove("flash");
  void trackEl.offsetWidth;
  trackEl.classList.add("flash");
}

export function initRail(cfgLayout?: unknown): void {
  root = document.getElementById("railWrap");
  if (!root) return;
  trackEl = root.querySelector<HTMLElement>(".rl-track");
  fillEl = root.querySelector<HTMLElement>(".rl-fill");
  notchesEl = root.querySelector<HTMLElement>(".rl-notches");
  notchesFor = 0;
  labEl = root.querySelector<HTMLElement>(".lab");
  timeEl = root.querySelector<HTMLElement>(".time");
  stepsEl = root.querySelector<HTMLElement>(".st");
  escEl = root.querySelector<HTMLElement>(".right");
  toolsEl = root.querySelector<HTMLElement>(".tools");
  eventsEl = root.querySelector<HTMLElement>(".events");
  lastEl = root.querySelector<HTMLElement>(".last");
  lastSepEl = root.querySelector<HTMLElement>(".last-sep");
  setLayout(cfgLayout);
  startTimer();
  // Смена фазы перерисовывает рельс сразу, а не через такт таймера.
  if (unsubActivity) unsubActivity();
  unsubActivity = activitySubscribeAll(render);
}

/** Таймер рендера рельса: только когда рельс включён и ход идёт. */
function startTimer(): void {
  if (timer) return;
  if (layout === "off") return;
  timer = setInterval(render, 250);
}

/** Остановить таймер рельса (ход закончен или рельс выключен). */
function stopTimer(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

export function setLayout(next: unknown): void {
  layout = typeof next === "string" && LAYOUTS.includes(next) ? next : "line";
  if (!root) return;
  root.classList.remove("l-line", "l-meta", "l-full");
  root.classList.add("l-" + layout);
  const inpMeta = document.querySelector(".inp-meta");
  const inputArea = document.querySelector(".input-area");
  if (layout === "meta" && inpMeta && root.parentElement !== inpMeta) {
    inpMeta.prepend(root);
  } else if (layout !== "meta" && inputArea && root.parentElement !== inputArea) {
    const selectors = inputArea.querySelector(".selectors");
    inputArea.insertBefore(root, selectors || inputArea.firstChild);
  }
  render();
}

export function setBusy(on: unknown): void {
  const next = !!on;
  if (next && !busy) resetSpeed(railKey() || null);
  busy = next;
  // Таймер живёт только пока идёт ход (и рельс включён) — фоновая висящая
  // петля шла и после конца хода (аудит §6.14).
  if (busy) startTimer();
  else stopTimer();
  render();
}

/**
 * План в рельсе. `sessionId` — владелец события `plan`; без него план
 * относится к активной вкладке (снапшот `state` из `renderActiveState`).
 */
export function setPlan(p: Dict | null, sessionId?: string | null): void {
  const key = sessionId ? String(sessionId) : railKey();
  if (!key) return;
  railSession(key).plan = p && Array.isArray(p.steps) && p.steps.length > 0 ? p : null;
  render();
}

/**
 * Ход сессии закончился: её счётчики и план больше не про текущую работу.
 * Событие есть у каждой сессии, поэтому фоновая вкладка тоже обнуляется —
 * при возврате в неё рельс показывает новый ход, а не прошлый.
 */
export function railTurnEnd(sessionId?: string | null): void {
  const key = sessionId ? String(sessionId) : railKey();
  if (!key) return;
  const st = railSession(key);
  st.tools = 0;
  st.events = 0;
  st.lastTool = "";
  st.plan = null;
  render();
}

// Счётчики рельса (тулы/события/последний тул) — по сессиям; фаза и время
// хода живут в `core/activity.ts`, чтобы лента и рельс не расходились.
// Фоновые события копятся в своей сессии, но рельс не рисуют: он — хром
// вкладки на экране.
export function railEvent(kind: string, name: string, sessionId?: string | null): void {
  const key = sessionId ? String(sessionId) : railKey();
  if (!key) return;
  const st = railSession(key);
  st.events += 1;
  if (kind === "tool_start") {
    st.lastTool = labelOf(name);
  } else if (kind === "tool_end") {
    st.tools += 1;
    st.lastTool = labelOf(name);
  }
  if (key !== railKey()) return;
  flash();
  render();
}

export function applyRailI18n(): void {
  render();
}
