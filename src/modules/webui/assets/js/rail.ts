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
import { resetSpeed, speedText, speedView } from "./speed.js";
import type { Dict } from "./core/store/types.js";

const LAYOUTS = ["off", "line", "meta", "full"];

let root: HTMLElement | null = null;
let trackEl: HTMLElement | null = null;
let fillEl: HTMLElement | null = null;
let notchesEl: HTMLElement | null = null;
let labEl: HTMLElement | null = null;
let timeEl: HTMLElement | null = null;
let speedEl: HTMLElement | null = null;
let stepsEl: HTMLElement | null = null;
let escEl: HTMLElement | null = null;
let toolsEl: HTMLElement | null = null;
let eventsEl: HTMLElement | null = null;
let lastEl: HTMLElement | null = null;
let lastSepEl: HTMLElement | null = null;
let layout = "line";
let busy = false;
let startedAt = 0;
let tools = 0;
let events = 0;
let lastTool = "";
let sawText = false;
let pendingTool = false;
let plan: Dict | null = null;
// biome-ignore lint/suspicious/noExplicitAny: opaque timer handle.
let timer: any = null;
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

function render(): void {
  if (!root || !labEl || !timeEl || !trackEl || !fillEl || !stepsEl || !toolsEl || !eventsEl || !lastEl || !escEl) {
    return;
  }
  root.hidden = layout === "off" || !busy;
  if (root.hidden) return;
  const phase = pendingTool ? "tool" : sawText ? "composing" : "thinking";
  root.classList.toggle("phase-tool", phase === "tool");
  root.classList.toggle("phase-compose", phase === "composing");
  labEl.textContent = "✦ " + (phase === "tool" ? t("web.rail.working")
    : phase === "composing" ? t("web.rail.composing") : t("web.action.thinking"));
  timeEl.textContent = ((Date.now() - startedAt) / 1000).toFixed(1) + "s";
  if (speedEl) {
    const sp = speedView(session.activeSessionId);
    speedEl.textContent = sp ? speedText(sp.value, sp.estimated) : "";
  }
  const steps = plan && Array.isArray(plan.steps) ? plan.steps : [];
  if (steps.length > 0) {
    const done = steps.filter((s: Dict) => s && s.status === "done").length;
    trackEl.dataset.mode = "plan";
    renderNotches(steps.length);
    fillEl.style.setProperty("--prog", String((done / steps.length) * 100));
    stepsEl.textContent = t("web.rail.step_of", { cur: Math.min(done + 1, steps.length), total: steps.length });
  } else {
    trackEl.dataset.mode = "scan";
    stepsEl.textContent = t("web.rail.no_plan");
  }
  toolsEl.textContent = pluralCount("web.rail.tools", tools);
  eventsEl.textContent = pluralCount("web.rail.events", events);
  // Без последнего тула не оставляем висящий разделитель и «—»: строка короче.
  if (lastSepEl) lastSepEl.hidden = !lastTool;
  lastEl.hidden = !lastTool;
  lastEl.textContent = lastTool ? t("web.rail.last") + " " + lastTool : "";
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
  speedEl = root.querySelector<HTMLElement>(".speed");
  stepsEl = root.querySelector<HTMLElement>(".st");
  escEl = root.querySelector<HTMLElement>(".right");
  toolsEl = root.querySelector<HTMLElement>(".tools");
  eventsEl = root.querySelector<HTMLElement>(".events");
  lastEl = root.querySelector<HTMLElement>(".last");
  lastSepEl = root.querySelector<HTMLElement>(".last-sep");
  setLayout(cfgLayout);
  startTimer();
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
  if (next && !busy) {
    startedAt = Date.now();
    tools = 0;
    events = 0;
    lastTool = "";
    sawText = false;
    pendingTool = false;
    plan = null;
    resetSpeed(session.activeSessionId);
  }
  busy = next;
  // Таймер живёт только пока идёт ход (и рельс включён) — фоновая висящая
  // петля шла и после конца хода (аудит §6.14).
  if (busy) startTimer();
  else stopTimer();
  render();
}

export function setPlan(p: Dict | null): void {
  plan = p && Array.isArray(p.steps) && p.steps.length > 0 ? p : null;
  render();
}

export function railEvent(kind: string, name: string): void {
  events += 1;
  if (kind === "tool_start") { pendingTool = true; lastTool = labelOf(name); }
  else if (kind === "tool_end") { pendingTool = false; tools += 1; lastTool = labelOf(name); }
  else if (kind === "text") sawText = true;
  flash();
  render();
}

export function applyRailI18n(): void {
  render();
}
