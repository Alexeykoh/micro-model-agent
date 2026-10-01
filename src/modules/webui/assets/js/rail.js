// Activity rail — the indicator above the composer for the whole `busy` period.
//
// The in-feed `.busy` line clears on the first `text` event; the rail lives
// until the turn ends and shows only what we actually know: phase, elapsed,
// plan progress when a plan exists (MoE), tool/event counters. Without a plan
// the rail is an indeterminate scanner — no invented percentages.
// Layouts: off | line (default) | meta | full — see docs/specs/2026-09-27-activity-rail-design.md.

import { t, pluralCount } from "./i18n.js";
import { labelOf } from "./format.js";

const LAYOUTS = ["off", "line", "meta", "full"];

let root = null, trackEl = null, fillEl = null, notchesEl = null;
let labEl = null, timeEl = null, stepsEl = null, escEl = null;
let toolsEl = null, eventsEl = null, lastEl = null;
let layout = "line";
let busy = false, startedAt = 0;
let tools = 0, events = 0, lastTool = "";
let sawText = false, pendingTool = false;
let plan = null;
let timer = null;
let notchesFor = 0;

// Step boundaries are drawn from the real plan length: a single notch sits on
// every boundary (total - 1 of them), so 5 steps always yield 4 dividers.
function renderNotches(total) {
  if (!notchesEl || total === notchesFor) return;
  notchesFor = total;
  notchesEl.textContent = "";
  for (let i = 1; i < total; i++) {
    const mark = document.createElement("i");
    mark.style.left = ((i / total) * 100).toFixed(3) + "%";
    notchesEl.appendChild(mark);
  }
}

function render() {
  if (!root) return;
  root.hidden = layout === "off" || !busy;
  if (root.hidden) return;
  const phase = pendingTool ? "tool" : sawText ? "composing" : "thinking";
  root.classList.toggle("phase-tool", phase === "tool");
  root.classList.toggle("phase-compose", phase === "composing");
  labEl.textContent = "✦ " + (phase === "tool" ? t("web.rail.working")
    : phase === "composing" ? t("web.rail.composing") : t("web.action.thinking"));
  timeEl.textContent = ((Date.now() - startedAt) / 1000).toFixed(1) + "s";
  const steps = plan && Array.isArray(plan.steps) ? plan.steps : [];
  if (steps.length > 0) {
    const done = steps.filter((s) => s && s.status === "done").length;
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
  lastEl.textContent = lastTool ? t("web.rail.last") + " " + lastTool : t("web.rail.none");
  escEl.textContent = t("web.input.esc");
}

function flash() {
  if (!trackEl || !busy) return;
  trackEl.classList.remove("flash");
  void trackEl.offsetWidth;
  trackEl.classList.add("flash");
}

export function initRail(cfgLayout) {
  root = document.getElementById("railWrap");
  if (!root) return;
  trackEl = root.querySelector(".rl-track");
  fillEl = root.querySelector(".rl-fill");
  notchesEl = root.querySelector(".rl-notches");
  notchesFor = 0;
  labEl = root.querySelector(".lab");
  timeEl = root.querySelector(".time");
  stepsEl = root.querySelector(".st");
  escEl = root.querySelector(".right");
  toolsEl = root.querySelector(".tools");
  eventsEl = root.querySelector(".events");
  lastEl = root.querySelector(".last");
  setLayout(cfgLayout);
  if (!timer) timer = setInterval(render, 250);
}

export function setLayout(next) {
  layout = LAYOUTS.includes(next) ? next : "line";
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

export function setBusy(on) {
  const next = !!on;
  if (next && !busy) {
    startedAt = Date.now();
    tools = 0; events = 0; lastTool = "";
    sawText = false; pendingTool = false; plan = null;
  }
  busy = next;
  render();
}

export function setPlan(p) {
  plan = p && Array.isArray(p.steps) && p.steps.length > 0 ? p : null;
  render();
}

export function railEvent(kind, name) {
  events += 1;
  if (kind === "tool_start") { pendingTool = true; lastTool = labelOf(name); }
  else if (kind === "tool_end") { pendingTool = false; tools += 1; lastTool = labelOf(name); }
  else if (kind === "text") sawText = true;
  flash();
  render();
}

export function applyRailI18n() { render(); }
