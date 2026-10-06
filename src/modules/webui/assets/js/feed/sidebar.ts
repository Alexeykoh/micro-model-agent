// Sidebar renders owned by the feed module: usage panel, workspace path and the
// environment section. Extracted from `feed.js` (re-exported there).
import { usageEl, envEl, wsLine, el, icon, attachTooltip } from "../dom.js";
import { I18N, t, pluralCount } from "../i18n.js";
import { feed, settings } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { fmtTokens } from "../format.js";
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
    h.sessionId, h.model, h.contextUsed, h.contextLimit, h.cacheHitRate, h.costUsd,
    h.compactionCount, h.contextQuality, h.contextProbe, h.contextBreakdown, cfg.model, cfg.contextWindow,
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
  const hit = typeof h.cacheHitRate === "number" ? h.cacheHitRate : null;
  usageEl.appendChild(usageRow(t("web.usage.cache"), hit != null ? Math.round(hit * 100) + "%" : "—", hit != null ? "" : "dim"));
  usageEl.appendChild(usageRow(t("web.usage.cost"), typeof h.costUsd === "number" ? "$" + h.costUsd.toFixed(4) : "—"));
  usageEl.appendChild(usageRow(t("web.usage.compactions"), "⟳ " + (h.compactionCount || 0), h.compactionCount ? "wn" : "dim"));
  const q = typeof h.contextQuality === "number" ? h.contextQuality : null;
  usageEl.appendChild(usageRow(t("web.usage.quality"), q != null ? Math.round(q) + "%" : "—", q != null ? "" : "dim"));

  // Context probe: real LM Studio loaded context vs configured. Pending/absent
  // renders a dim dash; loaded < configured warns.
  let probeText = "—";
  let probeCls = "dim";
  const probe = h.contextProbe;
  if (probe && typeof probe.actual === "number") {
    const actual = fmtTokens(probe.actual);
    const configured = h.contextLimit || cfg.contextWindow || null;
    if (configured && probe.actual < configured) {
      probeText = t("web.usage.probe_low", { actual, configured: fmtTokens(configured) });
      probeCls = "wn";
    } else {
      probeText = t("web.usage.probe_loaded", { actual });
      probeCls = "";
    }
  }
  usageEl.appendChild(usageRow(t("web.usage.probe"), probeText, probeCls));
}

// Workspace path under the composer (dim, own line).
export function renderWorkspace(h: Dict): void {
  const ws = h.workspace || "";
  if (wsLine.dataset.ws === ws) return;
  wsLine.dataset.ws = ws;
  wsLine.textContent = "";
  wsLine.hidden = !ws;
  if (!ws) return;
  wsLine.appendChild(el("span", "ws-k", t("web.env.dir")));
  const v = el("span", "ws-v", ws);
  v.title = ws;
  wsLine.appendChild(v);
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
