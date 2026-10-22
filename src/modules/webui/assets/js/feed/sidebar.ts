// Sidebar renders owned by the feed module: usage panel, workspace path and the
// environment section. Extracted from `feed.js` (re-exported there).
import { usageEl, envEl, wsLine, el, icon, attachTooltip } from "../dom.js";
import { I18N, t, pluralCount } from "../i18n.js";
import { feed, settings } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { renderFooter } from "../footer.js";
import { fmtTokens, hiddenText } from "../format.js";
import { copyText } from "../../md.js";

function usageRow(label: string, value: string, cls?: string): HTMLElement {
  const row = el("div", "kv");
  row.appendChild(el("span", "", label));
  row.appendChild(el("b", cls || "", value));
  return row;
}

// Context parts shared by the bar and the legend: segment class, i18n label
// key and token count. Widths on the bar are token proportions.
type ContextPart = [cls: string, labelKey: string, n: number];
function contextParts(bd: Dict): ContextPart[] {
  return [
    ["seg-system", "web.usage.part_system", bd.system],
    ["seg-tools", "web.usage.part_tools", bd.tools],
    ["seg-history", "web.usage.part_history", bd.history],
    ["seg-reserve", "web.usage.part_reserve", bd.reserve],
    ["seg-free", "web.usage.part_free", bd.free],
  ];
}

// Tooltip body: colored dot + label + tokens + share of the window.
function tipContent(cls: string, labelKey: string, n: number, denom: number): Node {
  const frag = document.createDocumentFragment();
  frag.appendChild(el("i", "ctip-dot " + cls));
  frag.appendChild(el("span", "ctip-label", t(labelKey)));
  frag.appendChild(el("b", "", fmtTokens(n)));
  frag.appendChild(el("span", "ctip-pct", Math.round((n / denom) * 100) + "%"));
  return frag;
}

// Tooltip body for the quality row: each factor's normalized value, weight and
// point contribution, so the user sees how the 0..100 score is composed.
function qualityTip(bd: Dict): Node {
  const box = el("div", "qtip");
  const parts = Array.isArray(bd.parts) ? bd.parts : [];
  for (const p of parts) {
    const factor = typeof p.factor === "number" ? p.factor : 0;
    const weight = typeof p.weight === "number" ? p.weight : 0;
    const row = el("div", "qtip-row");
    row.appendChild(el("span", "ctip-label", t("web.usage.quality_" + String(p.key || ""))));
    row.appendChild(
      el("b", "", t("web.usage.quality_part", {
        value: Math.round(factor * 100),
        weight: Math.round(weight * 100),
        score: Math.round(factor * weight * 100),
      })),
    );
    box.appendChild(row);
  }
  return box;
}

// Previous context-part widths (segment class → tokens), kept across renders so
// a rebuilt bar can animate from the old width to the new one. `renderUsage`
// recreates the whole panel each update; without seeding, the fresh segments
// would jump straight to the final `flex-grow` with nothing to transition from.
const lastBarParts = new Map<string, number>();

// Seeds a segment at its previous width, then moves it to `target` on the next
// frame so the CSS `transition: flex-grow` runs. First sight / unchanged parts
// are set directly (no motion).
function applyBarStep(seg: HTMLElement, cls: string, target: number): void {
  const prev = lastBarParts.get(cls);
  lastBarParts.set(cls, target);
  if (prev === undefined || prev === target) {
    seg.style.flexGrow = String(target);
    return;
  }
  seg.style.flexGrow = String(prev);
  const apply = (): void => {
    seg.style.flexGrow = String(target);
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(apply);
  else apply();
}

// Segmented context bar: system · tools · history · reserve · free as separate
// rounded pills (flex-grow = tokens) so parts + gaps fill the full window.
function contextSegBar(h: Dict, used: number, limit: number): HTMLElement {
  const bar = el("div", "bar segbar");
  const bd = h.contextBreakdown;
  if (!bd || typeof bd.window !== "number" || bd.window <= 0) {
    // Legacy fallback (pre-breakdown payloads): single used/limit fill.
    const fill = el("i");
    fill.style.flex = "0 0 " + Math.min(100, Math.round((used / limit) * 100)) + "%";
    bar.appendChild(fill);
    return bar;
  }
  const denom = Math.max(bd.window, bd.used + bd.reserve);
  for (const [cls, labelKey, n] of contextParts(bd)) {
    if (!n || n <= 0) continue;
    const seg = el("i", cls);
    seg.style.flexBasis = "0";
    applyBarStep(seg, cls, n);
    seg.tabIndex = 0;
    seg.setAttribute("aria-label", [t(labelKey), fmtTokens(n), Math.round((n / denom) * 100) + "%"].join(" · "));
    attachTooltip(seg, () => tipContent(cls, labelKey, n, denom));
    bar.appendChild(seg);
  }
  return bar;
}

// Dim legend under the segmented bar: one dot+label+value per context part.
function contextLegend(h: Dict): HTMLElement {
  const box = el("div", "seglegend");
  const bd = h.contextBreakdown;
  if (!bd) return box;
  const denom = Math.max(bd.window, bd.used + bd.reserve);
  for (const [cls, labelKey, n] of contextParts(bd)) {
    if (!n || n <= 0) continue;
    const item = el("span", "segl-item");
    item.tabIndex = 0;
    item.setAttribute("aria-label", [t(labelKey), fmtTokens(n), Math.round((n / denom) * 100) + "%"].join(" · "));
    item.appendChild(el("i", "segl-dot " + cls));
    item.appendChild(el("span", "segl-label", t(labelKey)));
    item.appendChild(el("b", "", fmtTokens(n)));
    attachTooltip(item, () => tipContent(cls, labelKey, n, denom));
    box.appendChild(item);
  }
  return box;
}

// Session row with a copy button next to the id (icon-only, ✓ on success).
function usageSessionRow(sessionId: string): HTMLElement {
  const row = el("div", "kv");
  row.appendChild(el("span", "", t("web.usage.session")));
  const val = el("span", "kv-val");
  if (!sessionId) {
    val.appendChild(el("b", "", "—"));
  } else {
    val.appendChild(el("b", "", sessionId));
    const btn = el("button", "copy-btn");
    btn.type = "button";
    btn.title = t("web.usage.copy_id");
    btn.setAttribute("aria-label", t("web.usage.copy_id"));
    btn.appendChild(icon("copy"));
    btn.addEventListener("click", () => {
      copyText(sessionId).then((ok: boolean) => {
        btn.replaceChildren(icon(ok ? "check" : "copy"));
        setTimeout(() => btn.replaceChildren(icon("copy")), 1500);
      });
    });
    val.appendChild(btn);
  }
  row.appendChild(val);
  return row;
}

export function renderUsage(h: Dict): void {
  const cfg = settings.config || {};
  const sig = JSON.stringify([
    h.sessionId, h.model, h.contextUsed, h.contextLimit, h.contextWindow, h.cacheHitRate, h.costUsd,
    h.compactionCount, h.contextQuality, h.contextQualityBreakdown, h.contextProbe, h.contextBreakdown, cfg.model, cfg.contextWindow,
    I18N.locale,
  ]);
  if (sig === feed.lastUsageSig) return;
  feed.lastUsageSig = sig;
  usageEl.textContent = "";
  const sid = h.sessionId ? String(h.sessionId) : "";
  usageEl.appendChild(usageSessionRow(sid));
  usageEl.appendChild(usageRow(t("web.usage.model"), h.model || cfg.model || "—"));
  const used = typeof h.contextUsed === "number" ? h.contextUsed : null;
  const limit = typeof h.contextLimit === "number" ? h.contextLimit : cfg.contextWindow || null;
  usageEl.appendChild(usageRow(t("web.usage.context"), used != null && limit ? fmtTokens(used) + " / " + fmtTokens(limit) : "—"));
  if (used != null && limit) {
    usageEl.appendChild(contextSegBar(h, used, limit));
    usageEl.appendChild(contextLegend(h));
  }
  // Перегрузка окна: процент обрезан на 100 %, поэтому показываем явно.
  if (h.contextBreakdown && h.contextBreakdown.overcommitted) {
    usageEl.appendChild(usageRow(t("web.usage.context_overcommitted"), "⚠", "wn"));
  }
  const hit = typeof h.cacheHitRate === "number" ? h.cacheHitRate : null;
  usageEl.appendChild(usageRow(t("web.usage.cache"), hit != null ? Math.round(hit * 100) + "%" : "—", hit != null ? "" : "dim"));
  usageEl.appendChild(usageRow(t("web.usage.cost"), typeof h.costUsd === "number" ? "$" + h.costUsd.toFixed(4) : "—"));
  usageEl.appendChild(usageRow(t("web.usage.compactions"), "⟳ " + (h.compactionCount || 0), h.compactionCount ? "wn" : "dim"));
  const q = typeof h.contextQuality === "number" ? h.contextQuality : null;
  const qualityRow = usageRow(t("web.usage.quality"), q != null ? Math.round(q) + "%" : "—", q != null ? "" : "dim");
  if (h.contextQualityBreakdown) {
    attachTooltip(qualityRow, () => qualityTip(h.contextQualityBreakdown));
  }
  usageEl.appendChild(qualityRow);

  // Context probe: how many tokens the backend actually loaded for the model
  // (LM Studio and friends can load fewer than the configured window). We lead
  // with the loaded count — the number the user cares about — and do NOT print
  // the model's configured capacity; a low value is flagged instead.
  let probeText = "—";
  let probeCls = "dim";
  const probe = h.contextProbe;
  if (probe && typeof probe.actual === "number") {
    probeText = t("web.usage.probe_loaded", { actual: fmtTokens(probe.actual) });
    const configured = h.contextWindow || cfg.contextWindow || null;
    probeCls = configured && probe.actual < configured ? "wn" : "";
  }
  const probeRow = usageRow(t("web.usage.probe"), probeText, probeCls);
  if (probeCls === "wn") probeRow.title = t("web.usage.probe_hint");
  usageEl.appendChild(probeRow);
}

// Workspace path and agent version under the composer.
export function renderWorkspace(h: Dict): void {
  renderFooter(
    wsLine,
    {
      workspace: typeof h.workspace === "string" ? hiddenText(h.workspace) : h.workspace,
      version: h.version,
      updateAvailable: h.updateAvailable || undefined,
      dirLabel: t("web.env.dir"),
      updateTitle: t("web.update.chip_title", { latest: h.updateAvailable?.latest ?? "" }),
    },
    el,
  );
}

// Environment (sidebar): stacked name/value items — AGENTS.md sources, map size.
function envItem(label: string, values: string[]): HTMLElement {
  const item = el("div", "env-item");
  item.appendChild(el("div", "env-k", label));
  values.forEach((val) => {
    const v = el("div", "env-v", val);
    v.title = val;
    item.appendChild(v);
  });
  return item;
}

export function renderEnvironment(h: Dict): void {
  const disabled = !!(h.instructions && h.instructions.disabled);
  const files = h.instructions && !disabled ? h.instructions.files || [] : [];
  const map = h.projectMap || null;
  const sig = JSON.stringify([disabled, files, map, I18N.locale]);
  if (sig === feed.lastEnvSig) return;
  feed.lastEnvSig = sig;
  envEl.textContent = "";
  envEl.appendChild(
    envItem(
      t("web.env.agents"),
      disabled ? [t("web.env.agents_disabled")] : files.length ? files : [t("web.env.agents_none")],
    ),
  );
  envEl.appendChild(
    envItem(
      t("web.env.map"),
      map && map.indexed
        ? [
            [
              pluralCount("web.env.files", map.files),
              pluralCount("web.env.symbols", map.symbols),
              pluralCount("web.env.tokens", map.tokens),
            ].join(" · "),
          ]
        : [t("web.env.map_not_indexed")],
    ),
  );
}
