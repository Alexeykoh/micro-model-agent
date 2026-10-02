// Map tab for `mma web`: project-map snapshot + Re-index action. Split out of
// `sidebar.js`.
import { el } from "../dom.js";
import { api } from "../api.js";
import { t } from "../i18n.js";
import { fmtTokens } from "../format.js";
import { sb } from "./state.js";

function fmtUpdated(updatedAt) {
  if (typeof updatedAt !== "number") return t("web.sidebar.map_never");
  const d = new Date(updatedAt);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const time = pad(d.getHours()) + ":" + pad(d.getMinutes());
  if (d.toDateString() === now.toDateString()) return t("web.sidebar.map_today", { time });
  return pad(d.getDate()) + "." + pad(d.getMonth() + 1) + " " + time;
}

/** Labelled value row (shared with the LSP tab). */
export function mapKv(label, value, cls) {
  const row = el("div", ("kv" + (cls ? " " + cls : "")).trim());
  row.appendChild(el("span", "dim", label));
  const b = el("b");
  b.textContent = value;
  row.appendChild(b);
  return row;
}

// Корень — всегда длинный путь: подпись сверху, путь снизу на всю ширину.
// В одну flex-строку с подписью он не влезает и склеивается с ней.
function mapPathRow(label, value) {
  const wrap = el("div", "map-path");
  wrap.appendChild(el("span", "dim", label));
  const b = el("b");
  b.textContent = value;
  b.title = value;
  wrap.appendChild(b);
  return wrap;
}

export function sidebarMapState(host) {
  if (!sb.mapEl) return;
  const map = (host && host.projectMap) || { indexed: false, files: 0, symbols: 0, tokens: 0, languages: [] };
  const serverIndexing = !!(map && map.indexing);
  if (sb.postResolved && !serverIndexing) { sb.reindexing = false; sb.postResolved = false; }
  const indexing = serverIndexing || sb.reindexing;
  const num = (v) => (map.indexed ? String(v || 0) : "—");
  sb.mapEl.textContent = "";
  const status = indexing ? t("web.sidebar.map_indexing")
    : !map.indexed ? t("web.sidebar.map_never")
    : (map.watcher ? t("web.sidebar.map_ready") : t("web.sidebar.map_stale"));
  sb.mapEl.appendChild(mapKv(t("web.sidebar.map_status"), status));
  sb.mapEl.appendChild(mapKv(t("web.sidebar.map_updated"), fmtUpdated(map.updatedAt)));
  sb.mapEl.appendChild(mapKv(t("web.sidebar.map_watcher"), map.watcher ? t("web.sidebar.map_on") : t("web.sidebar.map_off")));
  sb.mapEl.appendChild(mapKv(t("web.sidebar.map_files"), num(map.files)));
  sb.mapEl.appendChild(mapKv(t("web.sidebar.map_symbols"), num(map.symbols)));
  sb.mapEl.appendChild(mapKv(t("web.sidebar.map_tokens"), map.indexed ? fmtTokens(map.tokens || 0) : "—"));
  if (host && host.workspace) sb.mapEl.appendChild(mapPathRow(t("web.sidebar.map_root"), host.workspace));

  if (Array.isArray(map.languages) && map.languages.length > 0) {
    const head = el("div", "kv");
    head.appendChild(el("span", "dim", t("web.sidebar.map_languages")));
    sb.mapEl.appendChild(head);
    map.languages.forEach((l) => sb.mapEl.appendChild(mapKv(l.language, l.files + " · " + l.symbols)));
  }
  if (sb.reindexError) sb.mapEl.appendChild(mapKv(t("web.sidebar.map_reindex_failed"), "—", "wn"));

  const btn = el("button", "map-reindex", indexing ? t("web.sidebar.map_reindexing") : t("web.sidebar.map_reindex"));
  btn.type = "button";
  btn.disabled = indexing || !map.indexed;
  btn.addEventListener("click", async () => {
    sb.reindexing = true;
    sb.postResolved = false;
    sb.reindexError = false;
    sidebarMapState(host);
    sidebarMapIndicator(host);
    const r = await api("/api/index", { method: "POST" });
    if (!r.ok) {
      sb.reindexing = false;
      sb.postResolved = false;
      sb.reindexError = true;
      sidebarMapState(host);
      return;
    }
    // Свежий снапшот (поллинг / `state`-broadcast по завершении) снимет спиннер.
    sb.postResolved = true;
  });
  sb.mapEl.appendChild(btn);
}

export function sidebarMapIndicator(host) {
  const tab = sb.el && sb.el.querySelector('.sb-tab[data-tab="map"]');
  if (!tab) return;
  const map = (host && host.projectMap) || null;
  const busy = (map && map.indexing) || sb.reindexing;
  const next = busy ? "busy" : map && map.indexed && !map.watcher ? "stale" : "";
  tab.dataset.indicator = next;
}
