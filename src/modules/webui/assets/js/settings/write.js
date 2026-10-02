// Settings write funnel + composer selectors + config/model loaders.
// Extracted from `settings.js`. `postConfig` is the single write path used by
// the panels and the provider form; the settings shell (modal) registers the
// render callbacks via `setWriteHooks`, so this module never imports upward.
import { el, icon, link, connStatus, staleBar } from "../dom.js";
import { api } from "../api.js";
import { t, loadI18n } from "../i18n.js";
import { settings, session, setPath, getPath, hooks } from "../store.js";
import { contextLabel, matchesQuery } from "../format.js";
import { closeAllMenus, setSessOpen } from "../core/menus.js";
import { setIndicator } from "../dialog.js";
import { setLayout } from "../rail.js";

function setSelButton(btn, label, value) {
  btn.textContent = label + ":";
  btn.appendChild(el("b", "", value));
  btn.appendChild(icon("chevron-down"));
}

function menuItem(label, sub, active, onClick) {
  const mi = el("button", "mi" + (active ? " on" : ""));
  mi.type = "button";
  mi.setAttribute("aria-pressed", active ? "true" : "false");
  mi.appendChild(el("span", "", label));
  if (sub) mi.appendChild(el("span", "sub", sub));
  mi.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
    closeAllMenus();
  });
  return mi;
}

// Menu action row (refresh, custom, add…) with an optional leading icon.
function menuAction(label, iconName, onClick) {
  const mi = el("button", "mi row-mi");
  mi.type = "button";
  if (iconName) mi.appendChild(icon(iconName));
  mi.appendChild(el("span", "", label));
  mi.addEventListener("click", (e) => {
    e.stopPropagation();
    closeAllMenus();
    onClick();
  });
  return mi;
}

// Live filter text of the composer model dropdown. Kept module-level so a
// `renderSelectors()` re-read (config/models reload) preserves the query and
// the input is rebuilt with it; cleared once a model is actually picked.
let modelFilter = "";

export function renderSelectors() {
  const cfg = settings.config || {};
  const provider = cfg.provider || {};

  setSelButton(document.getElementById("selModelBtn"), t("web.selectors.model"), cfg.model || "—");
  const modelMenu = document.getElementById("selModelMenu");
  modelMenu.textContent = "";
  // Search row stays outside the filtered list: `drawModelList` only touches
  // `listBox`, so typing never rebuilds (or unfocuses) the input itself.
  const search = document.createElement("input");
  search.id = "selModelSearch";
  search.className = "searchbox";
  search.type = "search";
  search.autocomplete = "off";
  search.spellcheck = false;
  search.placeholder = t("web.selectors.search_models");
  search.setAttribute("aria-label", t("web.selectors.search_models"));
  search.value = modelFilter;
  search.addEventListener("click", (e) => e.stopPropagation());
  modelMenu.appendChild(search);
  const listBox = el("div", "model-menu-list");
  modelMenu.appendChild(listBox);
  const drawModelList = () => {
    listBox.textContent = "";
    const models = settings.models.filter((m) => matchesQuery(m, modelFilter));
    if (!models.length) {
      listBox.appendChild(el("div", "mi dim", settings.models.length ? t("web.settings.no_matches") : t("web.selectors.no_models")));
      return;
    }
    models.forEach((m) => {
      const item = menuItem(m, "", m === cfg.model, () => {
        modelFilter = "";
        postConfig("model", m, true);
      });
      // ArrowUp on the first row returns focus to the search field.
      item.addEventListener("keydown", (e) => {
        if (e.key === "ArrowUp" && item === listBox.querySelector(".mi:not(.dim)")) {
          e.preventDefault();
          e.stopPropagation();
          search.focus();
        }
      });
      listBox.appendChild(item);
    });
  };
  search.addEventListener("input", () => {
    modelFilter = search.value;
    drawModelList();
  });
  search.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const first = listBox.querySelector(".mi:not(.dim)");
      if (first) first.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const first = listBox.querySelector(".mi:not(.dim)");
      if (first) first.click();
    } else if (e.key === "Escape") {
      if (search.value) {
        e.preventDefault();
        search.value = "";
        modelFilter = "";
        drawModelList();
      } else {
        closeAllMenus();
      }
    }
  });
  drawModelList();
  modelMenu.appendChild(el("div", "sep"));
  modelMenu.appendChild(
    menuAction(t("web.selectors.refresh_list"), "refresh", () => {
      loadModels().then(renderSelectors);
    }),
  );

  setSelButton(document.getElementById("selProviderBtn"), t("web.selectors.provider"), provider.active || provider.type || "—");
  const provMenu = document.getElementById("selProviderMenu");
  provMenu.textContent = "";
  const entries = Array.isArray(provider.entries) && provider.entries.length
    ? provider.entries
    : [{ label: provider.active || provider.type, type: provider.type }];
  entries.forEach((entry) => {
    const name = entry.label || entry.type;
    if (!name) return;
    provMenu.appendChild(menuItem(name, entry.type || "", name === (provider.active || provider.type), () => postConfig("provider.active", name, true)));
  });

  setSelButton(document.getElementById("selContextBtn"), t("web.selectors.context"), contextLabel());
  const ctxMenu = document.getElementById("selContextMenu");
  ctxMenu.textContent = "";
  const sizes = [8192, 16384, 32768, 65536, 131072];
  sizes.forEach((n) => {
    ctxMenu.appendChild(menuItem(Math.round(n / 1024) + "K", n === cfg.contextWindow ? t("web.selectors.current") : "", n === cfg.contextWindow, () => postConfig("contextWindow", n, false)));
  });
  ctxMenu.appendChild(el("div", "sep"));
  // Inline custom size (no native `window.prompt`): the menu stays open while
  // typing; Enter/save commits and closes it.
  const custom = el("button", "mi row-mi");
  custom.type = "button";
  custom.appendChild(icon("settings"));
  custom.appendChild(el("span", "", t("web.selectors.custom")));
  custom.addEventListener("click", (e) => {
    e.stopPropagation();
    if (ctxMenu.querySelector(".ctx-custom")) return;
    const wrap = el("div", "ctx-custom");
    const input = el("input");
    input.type = "number";
    input.min = "1024";
    input.step = "1024";
    input.value = String(cfg.contextWindow || 32768);
    input.placeholder = t("web.selectors.context_prompt");
    input.setAttribute("aria-label", t("web.selectors.context_prompt"));
    const commit = () => {
      const n = Number(input.value.trim());
      if (Number.isFinite(n) && n >= 1024) {
        closeAllMenus();
        postConfig("contextWindow", n, false);
      } else {
        input.focus();
      }
    };
    input.addEventListener("click", (ev) => ev.stopPropagation());
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") {
        ev.preventDefault();
        commit();
      } else if (ev.key === "Escape") {
        wrap.remove();
      }
    });
    const ok = link(t("web.settings.save"), "", commit);
    wrap.appendChild(input);
    wrap.appendChild(ok);
    ctxMenu.appendChild(wrap);
    setTimeout(() => input.focus(), 0);
  });
  ctxMenu.appendChild(custom);

  renderReasoningSelector();

  // Keep the pending paint in sync: boot (config === null) and an in-flight
  // switch both show the mark; a mid-switch re-read must not clear it.
  paintSelectorPending();
}

const REASONING_LEVELS_FULL = ["auto", "default", "none", "low", "medium", "high", "max"];
// Backends without granularity (prompt-tag, template-kwarg) collapse
// medium/max into low/high — show the collapsed set, no duplicates.
const REASONING_LEVELS_COARSE = ["auto", "default", "none", "low", "high"];

// 4th selector row: reasoning effort filtered to what the active
// provider+model actually supports (`GET /api/models` → `reasoning`).
// Unknown (boot) or `strategy: "none"` → hidden, never a wrong option list.
// Probe failed → the row stays with an honest `off` mark and a shortcut to
// Settings → Reasoning instead of dead levels.
function renderReasoningSelector() {
  const wrap = document.querySelector('[data-sel="reasoning"]');
  const btn = document.getElementById("selReasoningBtn");
  const menu = document.getElementById("selReasoningMenu");
  if (!wrap || !btn || !menu) return;
  const info = session.reasoning;
  if (!info || info.strategy === "none") {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  if (info.supported === false) {
    setSelButton(btn, t("web.selectors.reasoning"), t("web.selectors.reasoning_off"));
    menu.textContent = "";
    menu.appendChild(el("div", "mi dim", t("reasoning.probe_failed")));
    menu.appendChild(el("div", "sep"));
    menu.appendChild(
      menuAction(t("web.settings.reasoning"), "settings", () => writeHooks.openSettingsAt?.("reasoning")),
    );
    return;
  }
  const mode = (settings.config && getPath(settings.config, "reasoning.mode")) || info.mode || "auto";
  setSelButton(btn, t("web.selectors.reasoning"), String(mode));
  menu.textContent = "";
  const levels = info.strategy === "openai-effort" ? REASONING_LEVELS_FULL : REASONING_LEVELS_COARSE;
  levels.forEach((lvl) => {
    menu.appendChild(menuItem(lvl, lvl === mode ? t("web.selectors.current") : "", lvl === mode, () => postConfig("reasoning.mode", lvl, false)));
  });
}

document.querySelectorAll("[data-sel]").forEach((sel) => {
  const btn = sel.querySelector("button");
  btn.setAttribute("aria-haspopup", "menu");
  btn.setAttribute("aria-expanded", "false");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    setSessOpen(false);
    document.querySelectorAll("[data-sel]").forEach((s) => {
      if (s !== sel) {
        s.classList.remove("open");
        const b = s.querySelector("button");
        if (b) b.setAttribute("aria-expanded", "false");
      }
    });
    const open = sel.classList.toggle("open");
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    // Opening the model menu lands focus in its search field.
    if (open && sel.dataset && sel.dataset.sel === "model") {
      const search = document.getElementById("selModelSearch");
      if (search) setTimeout(() => search.focus(), 0);
    }
  });
});

// Selector keys (`provider/model/context/reasoning`) share the switch treatment:
// pending paint + single-flight + parallel re-reads. Settings-panel writes
// bypass it (plain POST + save toast).
const SELECTOR_KEYS = ["provider.active", "model", "contextWindow", "reasoning.mode"];

// Monotonic id for selector switches: a slow A→B→A pair must not let the
// stale reply repaint over the fresh one.
let switchSeq = 0;
// Key of the in-flight selector switch, if any. While set, every selector
// button carries the pending mark and all selector menus are inert (CSS gates
// on `.selectors[data-pending]`), so a double-click is answered with a toast
// instead of a second concurrent switch.
let pendingKey = null;

// UI callbacks registered by the settings shell (`settings/modal.js`). Kept as
// a hook so this write funnel never imports the panels/shell (no cycle).
let writeHooks = { renderSettings: null, openSettingsAt: null };

/** Settings shell injects its render entry points; keeps the module DAG acyclic. */
export function setWriteHooks(d) {
  writeHooks = { ...writeHooks, ...d };
}

// Paint the pending mark (`⋯` via CSS `::after`, no label rewrites) and the
// `aria-busy` flag. Boot (`config === null`) paints the same mark, so the
// skeleton state is visible while `boot()` loads config/models/providers.
function paintSelectorPending() {
  const show = pendingKey !== null || !settings.config;
  const wrap = document.querySelector(".selectors");
  if (wrap) {
    if (show) wrap.setAttribute("data-pending", pendingKey || "boot");
    else wrap.removeAttribute("data-pending");
  }
  ["selProviderBtn", "selModelBtn", "selContextBtn", "selReasoningBtn"].forEach((id) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.classList.toggle("pending", show);
    btn.setAttribute("aria-busy", show ? "true" : "false");
  });
}

export async function postConfig(key, value, refreshSettings) {
  const isSelector = SELECTOR_KEYS.indexOf(key) !== -1;
  if (isSelector && pendingKey !== null) {
    setIndicator(t("web.selectors.switch_busy"), true);
    return false;
  }
  // Non-selector writes must not touch the sequence: otherwise a settings
  // write landing mid-switch would orphan `pendingKey` (stale-guard skips the
  // only `finally` that clears it).
  let seq = 0;
  if (isSelector) {
    seq = ++switchSeq;
    pendingKey = key;
    closeAllMenus();
    paintSelectorPending();
  }
  try {
    const r = await api("/api/config", { method: "POST", body: { key, value } });
    if (!r.ok || !r.data || !r.data.ok) {
      const err = (r.data && (r.data.error || r.data.reason)) || r.status || t("web.settings.save_failed");
      setIndicator(String(err), true);
      return false;
    }
    const persisted = r.data.persisted !== false;
    setIndicator(persisted ? t("web.settings.saved") : (r.data.warning || "not persisted"), !persisted);
    if (settings.config && r.data.value !== undefined) setPath(settings.config, key, r.data.value);
    if (key === "ui.activityRail") setLayout(String(r.data.value));
    if (key === "ui.fontSize") applyFontSize(String(r.data.value));
    if (key === "locale") {
      await loadI18n();
      if (hooks.applyStaticI18n) hooks.applyStaticI18n();
      writeHooks.renderSettings?.();
    }
    // A provider switch restores the per-provider model; a model change
    // updates that provider's remembered model. Both are independent GETs,
    // so re-read them in parallel. Context/reasoning switches only need the
    // config back (no extra model round-trip).
    if (key === "provider.active" || key === "model") {
      await Promise.all([loadConfig(), loadModels()]);
    } else if (isSelector) {
      await loadConfig();
    }
    // Stale reply (a newer switch started while this one was in flight):
    // leave the paint and the final render to the newer operation.
    if (isSelector && seq !== switchSeq) return true;
    renderSelectors();
    if (refreshSettings) writeHooks.renderSettings?.();
    return true;
  } finally {
    if (isSelector && seq === switchSeq) {
      pendingKey = null;
      paintSelectorPending();
    }
  }
}

export async function loadConfig() {
  const r = await api("/api/config");
  if (!r.ok || !r.data) return;
  settings.config = r.data.config || {};
  settings.registry = Array.isArray(r.data.registry) ? r.data.registry : [];
  settings.webToken = typeof r.data.webToken === "string" ? r.data.webToken : null;
  applyFontSize();
  renderSelectors();
  writeHooks.renderSettings?.();
}

export async function loadModels() {
  const r = await api("/api/models");
  if (!r.ok || !r.data) return;
  settings.models = Array.isArray(r.data.models) ? r.data.models : [];
  // Reasoning support rides along with the model list (one round-trip):
  // the 4th selector row renders from this, never from a separate GET.
  if (r.data.reasoning && typeof r.data.reasoning === "object") session.reasoning = r.data.reasoning;
  renderSelectors();
}

// Connection-state banner: shown while the SSE stream is down. The server
// never replays events, so a reconnect only resyncs the state slices — the feed keeps
// whatever the live session already rendered (no duplication).
export function setConnStatus(disconnected) {
  if (!connStatus) return;
  connStatus.hidden = !disconnected;
  connStatus.textContent = disconnected ? "⋯ " + t("web.conn.reconnecting") : "";
}

// Stale-translations banner: dict files on disk are newer than the running
// server process, so the chrome may show raw keys. Rebuilt only on a state
// change (not on every 2s poll) to keep the reload-button focus stable;
// `force` re-renders the label after a locale switch.
let lastStale = null;
export function setStaleBar(stale, force) {
  if (!staleBar) return;
  // undefined = перерисовать последнее состояние (смена локали).
  const on = stale === undefined ? !!lastStale : !!stale;
  if (!force && on === lastStale) return;
  lastStale = on;
  staleBar.hidden = !on;
  staleBar.textContent = "";
  if (!on) return;
  staleBar.appendChild(el("span", "", "⚠ " + t("web.i18n.stale") + " "));
  staleBar.appendChild(link(t("web.i18n.reload"), "", () => location.reload()));
  return lastStale;
}

// Web chat font size (`ui.fontSize`, server config — unlike the theme, which
// is a browser-local preference). Applied as `body[data-font]` so the switch
// is instant and survives re-renders; unknown values fall back to the default.
export function applyFontSize(value) {
  const v = value || (settings.config && settings.config.ui && settings.config.ui.fontSize) || "comfortable";
  const known = v === "compact" || v === "large" ? v : "comfortable";
  if (known === "comfortable") document.body.removeAttribute("data-font");
  else document.body.setAttribute("data-font", known);
}
