// Plan rendering: the sidebar plan list (`renderPlan`) and the feed plan card
// (`onPlan`). Extracted from `feed.js`; re-exported there.
import { planEl, planCountEl, el } from "../dom.js";
import { I18N, t, pluralCount } from "../i18n.js";
import { feed, tabs as tabState } from "../store.js";
import { feedForEvent, clearEmpty, appendTo, activeFeed, scroll } from "./core.js";

// One marking for a plan step, shared by the sidebar (`renderPlan`) and the
// feed card (`onPlan`): status class + leading glyph for done/failed/current.
function planStepMark(step, isCurrent) {
  const status =
    step.status === "done" ? "done" : step.status === "failed" ? "fail" : isCurrent ? "cur" : "";
  const glyph =
    step.status === "done" ? "✓ " : step.status === "failed" ? "✗ " : isCurrent ? "▸ " : "○ ";
  return { status, glyph };
}

export function renderPlan(plan) {
  // The sidebar polls `/api/state` every 2s; skip a rebuild (and the scroll
  // reset it would cause) when the snapshot is unchanged.
  const sig = JSON.stringify([plan, I18N.locale]);
  if (sig === feed.lastPlanSig) return;
  feed.lastPlanSig = sig;
  planEl.textContent = "";
  if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) {
    planCountEl.textContent = "";
    planEl.appendChild(el("div", "kv dim", t("web.plan.none")));
    return;
  }
  const done = plan.steps.filter((s) => s.status === "done").length;
  const total = plan.steps.length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  planCountEl.textContent = done + " / " + total;
  const bar = el("div", "plan-bar");
  const track = el("span", "pbar");
  const fill = el("i");
  fill.style.width = pct + "%";
  track.appendChild(fill);
  bar.appendChild(track);
  bar.appendChild(el("span", "", pct + "%"));
  planEl.appendChild(bar);
  plan.steps.forEach((step, i) => {
    const current = i === plan.currentIndex && step.status !== "done" && step.status !== "failed";
    const { status, glyph } = planStepMark(step, current);
    planEl.appendChild(el("div", ("plan-step " + status).trim(), glyph + step.text));
  });
}

export function onPlan(data) {
  const feed = feedForEvent(data && data.sessionId);
  if (!feed || !data || !Array.isArray(data.steps) || !data.steps.length) return;
  clearEmpty(feed);
  const tab = tabState.tabs.find((x) => x.feed === feed);
  let card = tab ? tab.planCard : null;
  if (!card || card.parentNode !== feed) {
    card = el("div", "planblock");
    appendTo(feed, card);
    if (tab) tab.planCard = card;
  }
  card.textContent = "";
  const total = data.steps.length;
  const cur = typeof data.currentIndex === "number" ? data.currentIndex : -1;
  card.appendChild(el("div", "ph2", "◇ " + pluralCount("web.plan.heading", total)));
  data.steps.forEach((step, i) => {
    const { status, glyph } = planStepMark(step, i === cur);
    card.appendChild(el("div", ("st " + status).trim(), glyph + step.text));
  });
  if (feed === activeFeed()) scroll();
}
