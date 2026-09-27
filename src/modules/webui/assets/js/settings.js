// Settings panels, provider form + overlays, selectors, postConfig, loaders.
// Imports loaders-adjacent chrome (closeAllMenus, setSessOpen) and data loaders
// share from tabs; confirm/toast from dialog. Never imports app (the locale
// refresh reaches the app shell through the store hooks registry).
import {
el, icon, link, inlineTextNodes, connStatus, makeToggle,
} from "./dom.js";
import { api } from "./api.js";
import { t, loadI18n } from "./i18n.js";
import { S, setPath, getPath, THEME_KEY, hooks } from "./store.js";
import { contextLabel } from "./format.js";
import { closeAllMenus, setSessOpen } from "./tabs.js";
import { setIndicator, closeConfirm, confirmOverlay, trapTab } from "./dialog.js";
import { controlFor, PANEL_SECTIONS, keyToPanel } from "./settings-controls.js";

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

export function renderSelectors() {
  const cfg = S.state.config || {};
  const provider = cfg.provider || {};

  setSelButton(document.getElementById("selModelBtn"), t("web.selectors.model"), cfg.model || "—");
  const modelMenu = document.getElementById("selModelMenu");
  modelMenu.textContent = "";
  if (!S.state.models.length) {
    modelMenu.appendChild(el("div", "mi dim", t("web.selectors.no_models")));
  } else {
    S.state.models.forEach((m) => {
      modelMenu.appendChild(menuItem(m, "", m === cfg.model, () => postConfig("model", m, true)));
    });
  }
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
  });
});

async function postConfig(key, value, refreshSettings) {
  const r = await api("/api/config", { method: "POST", body: { key, value } });
  if (r.ok && r.data && r.data.ok) {
    const persisted = r.data.persisted !== false;
    setIndicator(persisted ? t("web.settings.saved") : (r.data.warning || "not persisted"), !persisted);
    if (S.state.config && r.data.value !== undefined) setPath(S.state.config, key, r.data.value);
    if (key === "locale") {
      await loadI18n();
      if (hooks.applyStaticI18n) hooks.applyStaticI18n();
      renderSettings();
    }
    // A provider switch restores the per-provider model; a model change
    // updates that provider's remembered model. Re-read both server-side.
    if (key === "provider.active" || key === "model") {
      await loadConfig();
      await loadModels();
    }
    renderSelectors();
    if (refreshSettings) renderSettings();
    return true;
  }
  const err = (r.data && (r.data.error || r.data.reason)) || r.status || t("web.settings.save_failed");
  setIndicator(String(err), true);
  return false;
}

export async function loadConfig() {
  const r = await api("/api/config");
  if (!r.ok || !r.data) return;
  S.state.config = r.data.config || {};
  S.state.registry = Array.isArray(r.data.registry) ? r.data.registry : [];
  S.state.webToken = typeof r.data.webToken === "string" ? r.data.webToken : null;
  renderSelectors();
  renderSettings();
}

export async function loadModels() {
  const r = await api("/api/models");
  if (!r.ok || !r.data) return;
  S.state.models = Array.isArray(r.data.models) ? r.data.models : [];
  renderSelectors();
}

export async function loadProviders() {
  const r = await api("/api/providers");
  S.state.providers = r.ok && r.data && Array.isArray(r.data.entries) ? r.data : undefined;
  S.state.providerPresets = r.ok && r.data && Array.isArray(r.data.presets) ? r.data.presets : [];
  renderModelPanel();
}

// Connection-S.state banner: shown while the SSE stream is down. The server
// never replays events, so a reconnect only resyncs S.state — the feed keeps
// whatever the live session already rendered (no duplication).
export function setConnStatus(disconnected) {
  if (!connStatus) return;
  connStatus.hidden = !disconnected;
  connStatus.textContent = disconnected ? "⋯ " + t("web.conn.reconnecting") : "";
}

// Panel → named sections lives in `settings-controls.js` (PANEL_SECTIONS).
// Custom panels (model/ui/browser…) render a bespoke body first and then their
// sections; purely generic panels (general/context/…) render sections only.

// Localized label for a registry key: `config.key.<canonical>`, falling back
// to the raw key when no translation exists (so a new key is never blank).
function configLabel(def) {
  const k = "config.key." + def.key;
  const tr = t(k);
  return tr === k ? def.key : tr;
}

// Localized enum value: `config.enum.<value>`, falling back to the raw value.
// The raw value is still what gets POSTed — only the label is translated.
function enumLabel(v) {
  const k = "config.enum." + v;
  const tr = t(k);
  return tr === k ? v : tr;
}

function defFor(key) {
  return S.state.registry.find((d) => d.key === key) || null;
}

function row(label, control, desc) {
  const r = el("div", "row");
  const left = el("div", "row-label");
  left.appendChild(el("span", "row-name", label));
  if (desc) left.appendChild(el("span", "row-desc", desc));
  r.appendChild(left);
  if (typeof control === "string") {
    const v = el("span", "val", control);
    v.title = control;
    r.appendChild(v);
  } else if (control) {
    r.appendChild(control);
  }
  return r;
}

function descFor(key) {
  const k = "config.desc." + key;
  const d = t(k);
  return d === k ? "" : d;
}

// Generic per-type control (`settings-controls.js`): bool toggle, enum
// select, int/share/list/json inputs. `post` funnels through `postConfig`.
function configControl(def, key) {
  const value = S.state.config ? getPath(S.state.config, key) : undefined;
  return controlFor(def, value, {
    label: configLabel(def),
    enumLabel,
    emptyLabel: t("config.enum.none"),
    fieldLabel: (k) => {
      const kk = "config.field." + k;
      const tr = t(kk);
      return tr === kk ? k : tr;
    },
    post: (v) => postConfig(key, v, false),
  });
}

// One titled section card: uppercase title + optional one-line explanation,
// then its setting rows. Titles come from PANEL_SECTIONS so a section name can
// never drift from the keys under it.
function sectionCard(section) {
  const card = el("div", "settings-section");
  const head = el("div", "sec-head");
  head.appendChild(el("span", "sec-title", t(section.titleKey)));
  card.appendChild(head);
  if (section.descKey) {
    const d = t(section.descKey);
    if (d !== section.descKey) card.appendChild(el("div", "sec-desc", d));
  }
  const body = el("div", "sec-body");
  section.keys.forEach((key) => {
    const def = defFor(key);
    if (!def) return;
    body.appendChild(row(configLabel(def), configControl(def, key), descFor(def.key)));
  });
  card.appendChild(body);
  return card;
}

// Render the PANEL_SECTIONS table for a panel. Panels with custom bodies call
// this after their own content so bespoke widgets stay on top.
function renderSections(panel, sections) {
  const container = document.querySelector('[data-panel="' + panel + '"]');
  if (!container) return;
  sections.forEach((section) => container.appendChild(sectionCard(section)));
}

function renderPanel(panel) {
  const container = document.querySelector('[data-panel="' + panel + '"]');
  if (!container) return;
  container.textContent = "";
  renderSections(panel, PANEL_SECTIONS[panel] || []);
}

function providerEntries() {
  if (S.state.providers && Array.isArray(S.state.providers.entries) && S.state.providers.entries.length) {
    return S.state.providers.entries;
  }
  const provider = (S.state.config && S.state.config.provider) || {};
  if (Array.isArray(provider.entries) && provider.entries.length) {
    return provider.entries.map((e) => ({
      type: e.type,
      label: e.label || e.type,
      baseUrl: e.baseUrl,
      hasApiKey: !!e.apiKey,
      contextWindow: e.contextWindow,
      priority: e.priority,
    }));
  }
  return [
    {
      type: provider.type,
      label: provider.active || provider.type,
      baseUrl: provider.baseUrl,
      hasApiKey: !!provider.apiKey,
    },
  ];
}

function providerName(p) {
  return p.label || p.type || "—";
}

function providerMeta(p) {
  const parts = [p.type];
  if (p.contextWindow) parts.push(Math.round(p.contextWindow / 1024) + "K");
  if (typeof p.rpm === "number" || typeof p.parallel === "number") {
    parts.push("rpm " + (p.rpm == null ? "—" : p.rpm) + " · x" + (p.parallel == null ? "—" : p.parallel));
  }
  return parts.join(" · ");
}

function pfield(labelKey, input) {
  const f = el("div", "pform-field");
  f.appendChild(el("label", "", t(labelKey)));
  input.setAttribute("aria-label", t(labelKey));
  f.appendChild(input);
  return f;
}

function providerInput(value, type, placeholder) {
  const input = el("input");
  input.type = type || "text";
  if (placeholder) input.placeholder = placeholder;
  if (value != null) input.value = String(value);
  return input;
}

function providerSelect(options, value) {
  const sel = el("select");
  const none = el("option", "", "—");
  none.value = "";
  sel.appendChild(none);
  options.forEach((v) => {
    const o = el("option", "", v);
    o.value = v;
    if (v === value) o.selected = true;
    sel.appendChild(o);
  });
  if (value == null) sel.value = "";
  return sel;
}

function providerCheck(value) {
  const input = el("input");
  input.type = "checkbox";
  input.checked = value === true;
  return input;
}

const CACHE_FLAG_KEYS = [
  "sessionHeader",
  "requestCachePrompt",
  "requestPromptCacheKey",
  "requestSessionId",
  "requestCacheControl",
  "requestStreamUsage",
];

// A titled group inside a settings panel (models / providers).
function settingsSection(titleKey) {
  const sec = el("div", "settings-section");
  const head = el("div", "sec-head");
  head.appendChild(el("span", "sec-title", t(titleKey)));
  sec.appendChild(head);
  const body = el("div", "sec-body");
  sec.appendChild(body);
  return { el: sec, head, body };
}

// Compact action control used inside list items (use / edit / delete).
function chip(label, cls, onClick) {
  const b = el("button", "chip" + (cls ? " " + cls : ""), label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

// Suggestions for the provider form: known provider types and common base URLs.
function providerHints() {
  const frag = document.createDocumentFragment();
  const types = el("datalist");
  types.id = "providerTypes";
  ["openai-compat", "lmstudio", "openrouter", "openai", "anthropic", "opencode-zen", "opencode-go"].forEach((v) => {
    const o = el("option");
    o.value = v;
    types.appendChild(o);
  });
  const urls = el("datalist");
  urls.id = "providerBaseUrls";
  [
    ["LM Studio", "http://localhost:1234/v1"],
    ["Ollama", "http://localhost:11434/v1"],
    ["OpenRouter", "https://openrouter.ai/api/v1"],
    ["OpenAI", "https://api.openai.com/v1"],
    ["Anthropic", "https://api.anthropic.com"],
  ].forEach(([label, value]) => {
    const o = el("option");
    o.value = value;
    o.label = label;
    urls.appendChild(o);
  });
  frag.appendChild(types);
  frag.appendChild(urls);
  return frag;
}

// One-click preset row: selecting a builtin fills type/label/base URL, so
// hosted providers need no URL knowledge. `custom` leaves the fields free.
// Returns the row node (null when no presets) plus the raw select for wiring.
function providerPresetField(editing) {
  const presets = S.state.providerPresets || [];
  if (!presets.length) return { presets, sel: null, node: null };
  const sel = el("select", "pform-preset");
  const custom = el("option", "", t("web.settings.provider_custom"));
  custom.value = "";
  sel.appendChild(custom);
  presets.forEach((p) => {
    const o = el("option", "", p.label || p.type);
    o.value = p.id;
    sel.appendChild(o);
  });
  const match =
    presets.find((p) => p.type === editing.type && p.baseUrl && p.baseUrl === editing.baseUrl) ||
    presets.find((p) => p.type === editing.type && !p.baseUrl) ||
    presets.find((p) => p.type === editing.type);
  if (match) sel.value = match.id;
  return { presets, sel, node: pfield("web.settings.provider_preset", sel) };
}

// Keep the preset select and the type field in sync both ways.
function wirePresetSync(presets, presetSel, mode, f) {
  if (!presetSel) return;
  presetSel.addEventListener("change", () => {
    const p = presets.find((x) => x.id === presetSel.value);
    if (!p) return;
    f.type.value = p.type;
    if (mode === "add" || !f.label.value.trim()) f.label.value = p.name;
    f.base.value = p.baseUrl || "";
  });
  f.type.addEventListener("input", () => {
    const sel = presets.find((x) => x.id === presetSel.value);
    if (!sel || f.type.value.trim() !== sel.type) presetSel.value = "";
  });
}

// Optional tuning fields stay collapsed so the form reads as "type + URL".
function providerAdvancedFields(editing) {
  const adv = el("details", "pform-adv");
  adv.appendChild(el("summary", "", t("web.settings.provider_advanced")));
  const advGrid = el("div", "pform-grid");
  const cache = editing.cache || {};
  const retry = editing.retry || {};
  const f = {
    ctx: providerInput(editing.contextWindow, "number", "32768"),
    prio: providerInput(editing.priority, "number", "0"),
    rpm: providerInput(editing.rpm, "number", "60"),
    par: providerInput(editing.parallel, "number", "1"),
    maxTokens: providerInput(editing.maxCompletionTokens, "number", "8192"),
    cacheMech: providerSelect(["auto", "explicit", "local", "none"], cache.mechanism),
    cacheReport: providerSelect(["openai", "deepseek", "anthropic", "ollama", "none"], cache.report),
    retryMax: providerInput(retry.maxRetries, "number", "3"),
    retryBase: providerInput(retry.baseDelay, "number", "1000"),
    retryMaxD: providerInput(retry.maxDelay, "number", "30000"),
  };
  f.cacheFlags = CACHE_FLAG_KEYS.map((key) => {
    const box = providerCheck(cache[key]);
    const wrap = el("label", "pform-check");
    wrap.appendChild(box);
    wrap.appendChild(el("span", "", key));
    return { key, box, node: wrap };
  });
  advGrid.appendChild(pfield("web.settings.provider_context", f.ctx));
  advGrid.appendChild(pfield("web.settings.provider_priority", f.prio));
  advGrid.appendChild(pfield("web.settings.provider_rpm", f.rpm));
  advGrid.appendChild(pfield("web.settings.provider_parallel", f.par));
  advGrid.appendChild(pfield("web.settings.provider_max_tokens", f.maxTokens));
  advGrid.appendChild(pfield("web.settings.provider_cache_mechanism", f.cacheMech));
  advGrid.appendChild(pfield("web.settings.provider_cache_report", f.cacheReport));
  adv.appendChild(advGrid);
  const retryGroup = el("div", "pform-checks");
  retryGroup.appendChild(el("span", "pform-checks-title", t("web.settings.provider_retry")));
  [["maxRetries", f.retryMax], ["baseDelay", f.retryBase], ["maxDelay", f.retryMaxD]].forEach(([key, input]) => {
    const wrap = el("label", "pform-check");
    wrap.appendChild(el("span", "", key));
    input.setAttribute("aria-label", key);
    wrap.appendChild(input);
    retryGroup.appendChild(wrap);
  });
  adv.appendChild(retryGroup);
  const flagGroup = el("div", "pform-checks");
  flagGroup.appendChild(el("span", "pform-checks-title", t("web.settings.provider_cache_flags")));
  f.cacheFlags.forEach(({ node }) => flagGroup.appendChild(node));
  adv.appendChild(flagGroup);
  return { node: adv, ...f };
}

// Validate the field bag, POST it, and refresh the panels on success.
async function submitProviderForm(f, mode, editing) {
  const type = f.type.value.trim();
  const baseUrl = f.base.value.trim();
  if (!type || !baseUrl) {
    setIndicator(t("web.settings.provider_required"), true);
    return;
  }
  const body = { type, baseUrl };
  const label = f.label.value.trim();
  if (label) body.label = label;
  if (mode === "edit") {
    const original = providerName(editing);
    if (original && original !== "—") body.originalName = original;
  }
  const key = f.key.value.trim();
  // Empty means "keep the stored key" (the field is never prefilled, only a
  // hint). `"***"` guards password-manager autofill of a masked placeholder.
  if (key && key !== "***") body.apiKey = key;
  const nums = [
    ["contextWindow", f.ctx, 1024],
    ["priority", f.prio, 0],
    ["rpm", f.rpm, 1],
    ["parallel", f.par, 1],
    ["maxCompletionTokens", f.maxTokens, 512, 128000],
    ["maxRetries", f.retryMax, 0, 10],
    ["baseDelay", f.retryBase, 0, 60000],
    ["maxDelay", f.retryMaxD, 0, 300000],
  ];
  const retry = {};
  for (const entry of nums) {
    const raw = entry[1].value.trim();
    if (!raw) continue;
    const n = Number(raw);
    const max = entry[3] === undefined ? Number.MAX_SAFE_INTEGER : entry[3];
    if (!Number.isInteger(n) || n < entry[2] || n > max) {
      setIndicator(t("web.settings.provider_invalid"), true);
      return;
    }
    if (entry[0] === "maxRetries" || entry[0] === "baseDelay" || entry[0] === "maxDelay") {
      retry[entry[0]] = n;
    } else {
      body[entry[0]] = n;
    }
  }
  if (Object.keys(retry).length) body.retry = retry;
  const cache = {};
  if (f.cacheMech.value) cache.mechanism = f.cacheMech.value;
  if (f.cacheReport.value) cache.report = f.cacheReport.value;
  const prevCache = (editing && editing.cache) || {};
  f.cacheFlags.forEach(({ key, box }) => {
    if (box.checked !== (prevCache[key] === true)) cache[key] = box.checked;
  });
  if (Object.keys(cache).length) body.cache = cache;
  const r = await api("/api/providers", { method: "POST", body });
  if (r.ok && r.data && r.data.ok) {
    const persisted = r.data.persisted !== false;
    setIndicator(persisted ? t("web.settings.saved") : r.data.warning || "not persisted", !persisted);
    closeSubDialog();
    await loadProviders();
    await loadConfig();
  } else {
    const err = (r.data && r.data.error) || "";
    setIndicator(
      err === "name-conflict" ? t("web.settings.provider_name_conflict") : err || t("web.settings.save_failed"),
      true,
    );
  }
}

function providerForm() {
  const mode = (S.state.providerForm && S.state.providerForm.mode) || "add";
  const editing = (S.state.providerForm && S.state.providerForm.entry) || {};
  const box = el("div", "pform");

  const { presets, sel: presetSel, node: presetNode } = providerPresetField(editing);
  if (presetNode) box.appendChild(presetNode);

  const grid = el("div", "pform-grid");
  const fType = providerInput(editing.type, "text", "openai-compat");
  fType.setAttribute("list", "providerTypes");
  const fLabel = providerInput(editing.label, "text", "my-provider");
  const fBase = providerInput(editing.baseUrl, "text", "http://localhost:1234/v1");
  fBase.setAttribute("list", "providerBaseUrls");
  const fKey = providerInput("", "password", editing.hasApiKey ? t("web.settings.provider_key_keep") : "");
  grid.appendChild(pfield("web.settings.provider_type", fType));
  grid.appendChild(pfield("web.settings.provider_label_field", fLabel));
  grid.appendChild(pfield("web.settings.provider_baseurl", fBase));
  grid.appendChild(pfield("web.settings.provider_apikey", fKey));
  box.appendChild(grid);
  wirePresetSync(presets, presetSel, mode, { type: fType, label: fLabel, base: fBase });

  const { node: advNode, ...advF } = providerAdvancedFields(editing);
  box.appendChild(advNode);
  const f = { type: fType, label: fLabel, base: fBase, key: fKey, ...advF };

  box.appendChild(providerHints());

  const actions = el("div", "pform-actions");
  actions.appendChild(link(t("web.settings.save"), "", () => submitProviderForm(f, mode, editing)));
  actions.appendChild(link(t("web.settings.cancel"), "dim", () => closeProviderForm()));
  box.appendChild(actions);
  return box;
}

function renderModelPanel() {
  const container = document.querySelector('[data-panel="model"]');
  if (!container) return;
  container.textContent = "";
  const cfg = S.state.config || {};

  // --- Model section ---
  const modelSec = settingsSection("web.settings.section_models");
  const search = el("input", "searchbox");
  search.placeholder = t("web.settings.search_models");
  search.setAttribute("aria-label", t("web.settings.search_models"));
  modelSec.body.appendChild(search);
  const list = el("div", "model-list");
  modelSec.body.appendChild(list);
  const draw = () => {
    list.textContent = "";
    const q = search.value.trim().toLowerCase();
    const models = S.state.models.filter((m) => !q || m.toLowerCase().indexOf(q) !== -1);
    if (!models.length) {
      list.appendChild(el("div", "placeholder", S.state.models.length ? t("web.settings.no_matches") : t("web.settings.no_models")));
      return;
    }
    models.forEach((m) => {
      const active = m === cfg.model;
      const item = el("div", "model-item" + (active ? " active" : ""));
      const nameEl = el("span", "m-name", m);
      nameEl.title = m;
      item.appendChild(nameEl);
      if (active) {
        item.appendChild(el("span", "m-meta", contextLabel() + " · " + t("web.settings.active_check")));
      } else {
        item.appendChild(chip(t("web.settings.use"), "", () => postConfig("model", m, true)));
      }
      list.appendChild(item);
    });
  };
  search.addEventListener("input", draw);
  draw();
  container.appendChild(modelSec.el);

  // --- Providers section ---
  const provSec = settingsSection("web.settings.section_providers");
  const addBtn = el("button", "sec-add");
  addBtn.type = "button";
  addBtn.setAttribute("aria-haspopup", "dialog");
  addBtn.appendChild(icon("plus"));
  addBtn.appendChild(el("span", "", t("web.settings.add_provider")));
  addBtn.addEventListener("click", () => openProviderForm("add", null));
  provSec.head.appendChild(addBtn);

  const entries = providerEntries().filter((e) => {
    const n = providerName(e);
    return n && n !== "—";
  });
  const activeName = (S.state.providers && S.state.providers.active) || cfg.provider?.active || cfg.provider?.type || "—";
  const provList = el("div", "provider-list");
  entries.forEach((entry) => {
    const name = providerName(entry);
    const active = name === activeName;
    const item = el("div", "provider-item" + (active ? " active" : ""));
    const head = el("div", "p-head");
    head.appendChild(el("span", "p-name", name));
    if (active) head.appendChild(el("span", "badge on", t("web.settings.active")));
    item.appendChild(head);
    const meta = providerMeta(entry);
    if (meta) item.appendChild(el("div", "p-meta", meta));
    const actions = el("div", "p-actions");
    if (!active) {
      actions.appendChild(chip(t("web.settings.provider_make_active"), "", () => postConfig("provider.active", name, true)));
    }
    actions.appendChild(
      chip(t("web.settings.edit"), "", () => openProviderForm("edit", entry)),
    );
    if (!active) {
      actions.appendChild(
        chip(t("web.settings.delete"), "danger", async () => {
          const r = await api("/api/providers/" + encodeURIComponent(name), { method: "DELETE" });
          if (r.ok && r.data && r.data.ok) {
            setIndicator(t("web.settings.saved"));
            await loadProviders();
            await loadConfig();
          } else {
            const err = (r.data && r.data.error) || t("web.settings.delete_failed");
            setIndicator(err === "active-provider" ? t("web.settings.provider_active_guard") : String(err), true);
          }
        }),
      );
    }
    item.appendChild(actions);
    provList.appendChild(item);
  });
  if (!entries.length) provList.appendChild(el("div", "placeholder", t("web.settings.providers_empty")));
  provSec.body.appendChild(provList);
  container.appendChild(provSec.el);
  renderSections("model", PANEL_SECTIONS.model || []);
}

function renderUiPanel() {
  const container = document.querySelector('[data-panel="ui"]');
  if (!container) return;
  container.textContent = "";
  const seg = el("span", "seg");
  ["dark", "light", "auto"].forEach((theme) => {
    const b = el("button", currentTheme() === theme ? "on" : "", theme);
    b.type = "button";
    b.setAttribute("aria-pressed", currentTheme() === theme ? "true" : "false");
    b.addEventListener("click", () => {
      seg.querySelectorAll("button").forEach((x) => {
        x.classList.remove("on");
        x.setAttribute("aria-pressed", "false");
      });
      b.classList.add("on");
      b.setAttribute("aria-pressed", "true");
      applyTheme(theme);
    });
    seg.appendChild(b);
  });
  // Theme is a browser-local preference (localStorage), not a config key, so it
  // gets its own card before the generated sections.
  const card = el("div", "settings-section");
  const head = el("div", "sec-head");
  head.appendChild(el("span", "sec-title", t("web.settings.sec.ui.theme")));
  card.appendChild(head);
  const desc = t("web.settings.sec.ui.theme.desc");
  if (desc !== "web.settings.sec.ui.theme.desc") card.appendChild(el("div", "sec-desc", desc));
  const body = el("div", "sec-body");
  body.appendChild(row(t("web.settings.theme"), seg));
  card.appendChild(body);
  container.appendChild(card);
  renderSections("ui", PANEL_SECTIONS.ui || []);
}

function renderSecurityPanel() {
  const container = document.querySelector('[data-panel="security"]');
  if (!container) return;
  container.textContent = "";
  renderSections("security", PANEL_SECTIONS.security || []);
  const access = el("div", "settings-section");
  const head = el("div", "sec-head");
  head.appendChild(el("span", "sec-title", t("web.settings.sec.security.access")));
  access.appendChild(head);
  const body = el("div", "sec-body");
  body.appendChild(
    row(t("web.settings.web_token"), el("span", "val dim", S.state.webToken || t("web.settings.web_token_none")), t("config.desc.webToken")),
  );
  const note = el("div", "placeholder");
  note.appendChild(el("span", "tag", t("web.settings.terminal_tag")));
  note.appendChild(document.createTextNode(" " + t("web.settings.security_note")));
  body.appendChild(note);
  access.appendChild(body);
  container.appendChild(access);
}

function placeholderFor(data, empty) {
  const d = el("div", "placeholder");
  if (data === undefined) d.textContent = t("web.settings.loading");
  else d.textContent = empty;
  return d;
}

function groupHeader(label, count) {
  const head = el("div", "row");
  head.appendChild(el("span", "val accent", label));
  if (count != null) head.appendChild(el("span", "val dim", String(count)));
  return head;
}

const MEMORY_CATEGORIES = ["conventions", "decisions", "errors", "facts"];

/** Nested dialog: pick a memory category and write the note. */
function openMemoryForm() {
  const box = el("div", "pform");
  const grid = el("div", "pform-grid");
  const catSel = el("select");
  catSel.setAttribute("aria-label", t("web.settings.memory_category"));
  MEMORY_CATEGORIES.forEach((c) => catSel.appendChild(el("option", "", c)));
  catSel.value = "facts";
  grid.appendChild(mcpLiteralField(t("web.settings.memory_category"), catSel));
  box.appendChild(grid);
  const area = el("textarea");
  area.rows = 5;
  area.placeholder = t("web.settings.new_memory");
  area.value = "";
  box.appendChild(mcpLiteralField(t("web.settings.new_memory"), area));
  const actions = el("div", "pform-actions");
  actions.appendChild(
    link(t("web.settings.save"), "", async () => {
      const text = area.value.trim();
      if (!text) {
        area.focus();
        return;
      }
      const r = await api("/api/memory", { method: "POST", body: { category: catSel.value, text } });
      if (r.ok && r.data && r.data.ok) {
        closeSubDialog();
        await loadMemory();
      } else {
        setIndicator(t("web.settings.add_failed"), true);
      }
    }),
  );
  actions.appendChild(link(t("web.settings.cancel"), "dim", () => closeSubDialog()));
  box.appendChild(actions);
  openSubDialog(t("web.settings.memory_add_title"), box, () => renderMemoryPanel());
}

function renderMemoryPanel() {
  const container = document.querySelector('[data-panel="memory"]');
  if (!container) return;
  container.textContent = "";
  if (S.state.memory === undefined || S.state.memory === null) {
    container.appendChild(placeholderFor(S.state.memory, t("web.settings.memory_unavailable")));
    return;
  }
  const data = S.state.memory;

  // Adding an entry opens the shared nested dialog: a category + a multi-line
  // note with room to write, instead of a cramped inline field.
  const addBtn = el("button", "sec-add");
  addBtn.type = "button";
  addBtn.appendChild(icon("plus"));
  addBtn.appendChild(el("span", "", t("web.settings.add")));
  addBtn.addEventListener("click", () => openMemoryForm());
  const addHead = el("div", "sec-head");
  addHead.appendChild(el("span", "sec-title", t("web.settings.sec.memory.add")));
  addHead.appendChild(addBtn);
  const addSec = el("div", "settings-section");
  addSec.appendChild(addHead);
  container.appendChild(addSec);

  const search = el("input", "searchbox");
  search.placeholder = t("web.settings.search_memory");
  search.setAttribute("aria-label", t("web.settings.search_memory"));
  container.appendChild(search);
  const list = el("div", "settings-list");
  container.appendChild(list);

  const categoryHeader = (label, count) => {
    const head = el("div", "mem-cat");
    head.appendChild(el("span", "", label));
    if (count != null) head.appendChild(el("span", "n", String(count)));
    return head;
  };

  const entryBlock = (text, onForget) => {
    const block = el("div", "mem-entry");
    const body = el("span", "mem-text");
    body.appendChild(inlineTextNodes(text));
    body.title = String(text == null ? "" : text);
    block.appendChild(body);
    if (onForget) block.appendChild(link(t("web.settings.forget"), "mem-del", onForget));
    return block;
  };

  const draw = () => {
    list.textContent = "";
    const q = search.value.trim().toLowerCase();
    let any = false;
    (data.categories || []).forEach((cat) => {
      const entries = (cat.entries || []).filter(
        (e) => !q || String(e.text).toLowerCase().indexOf(q) !== -1,
      );
      if (!entries.length) return;
      any = true;
      list.appendChild(categoryHeader(cat.name, entries.length));
      entries.forEach((e) => {
        list.appendChild(
          entryBlock(e.text, async () => {
            const r = await api(
              "/api/memory/" + encodeURIComponent(cat.name) + "/" + e.n,
              { method: "DELETE" },
            );
            if (r.ok) await loadMemory();
            else setIndicator(t("web.settings.forget_failed"), true);
          }),
        );
      });
    });
    const prefs = Object.entries(data.preferences || {});
    if (prefs.length && !q) {
      any = true;
      list.appendChild(categoryHeader(t("web.settings.preferences"), prefs.length));
      prefs.forEach(([k, v]) => {
        list.appendChild(entryBlock(k + " = " + v));
      });
    }
    if (!any) {
      const empty = el("div", "placeholder");
      empty.textContent = q ? t("web.settings.no_matches") : t("web.settings.no_memory");
      list.appendChild(empty);
    }
  };
  search.addEventListener("input", draw);
  draw();
}

function renderSkillsPanel() {
  const container = document.querySelector('[data-panel="skills"]');
  if (!container) return;
  container.textContent = "";
  if (S.state.skills === undefined || S.state.skills === null) {
    container.appendChild(placeholderFor(S.state.skills, t("web.settings.skills_unavailable")));
    return;
  }
  if (!S.state.skills.length) {
    const empty = el("div", "placeholder");
    empty.textContent = t("web.settings.no_skills");
    container.appendChild(empty);
    return;
  }
  const list = el("div", "settings-list");
  S.state.skills.forEach((s) => {
    const item = el("div", "skill-item");
    const head = el("div", "skill-head");
    head.appendChild(el("span", s.enabled ? "g" : "dim", s.enabled ? "✓" : "○"));
    const nameEl = el("span", "name", s.name);
    nameEl.title = s.name;
    head.appendChild(nameEl);
    head.appendChild(el("span", "st", s.enabled ? t("web.settings.enabled") : t("web.settings.available")));
    item.appendChild(head);
    if (s.source) {
      const src = el("div", "skill-src", s.source);
      src.title = s.source;
      item.appendChild(src);
    }
    list.appendChild(item);
  });
  container.appendChild(list);
}

function renderPluginsPanel() {
  const container = document.querySelector('[data-panel="plugins"]');
  if (!container) return;
  container.textContent = "";
  if (S.state.pluginsData === undefined || S.state.pluginsData === null) {
    container.appendChild(placeholderFor(S.state.pluginsData, t("web.settings.plugins_unavailable")));
    return;
  }
  const data = S.state.pluginsData;
  const list = el("div", "settings-list");
  list.appendChild(groupHeader(t("web.settings.plugins_header"), (data.plugins || []).length));
  if (!(data.plugins || []).length) {
    const empty = el("div", "placeholder");
    empty.textContent = t("web.settings.no_plugins");
    list.appendChild(empty);
  }
  (data.plugins || []).forEach((p) => {
    const line = el("div", "list-line");
    line.appendChild(el("span", "g", "✓"));
    const nameEl = el("span", "name", p.name);
    nameEl.title = p.name;
    line.appendChild(nameEl);
    if (p.version) line.appendChild(el("span", "src", "v" + p.version));
    if (p.source) {
      const src = el("span", "src", p.source);
      src.title = p.source;
      line.appendChild(src);
    }
    if (p.builtin) line.appendChild(el("span", "src", t("web.settings.builtin")));
    line.appendChild(el("span", "st", p.enabled === false ? t("web.settings.disabled") : t("web.settings.enabled")));
    list.appendChild(line);
  });
  const pnote = el("div", "settings-note");
  pnote.textContent = t("web.settings.plugins_note");
  list.appendChild(pnote);

  list.appendChild(groupHeader(t("web.settings.mcp_servers"), (data.mcp || []).length));
  const mcpAdd = el("button", "sec-add");
  mcpAdd.type = "button";
  mcpAdd.appendChild(icon("plus"));
  mcpAdd.appendChild(el("span", "", t("web.settings.mcp_add")));
  mcpAdd.addEventListener("click", () => openMcpForm("add", null));
  list.appendChild(mcpAdd);
  if (!(data.mcp || []).length) {
    const empty = el("div", "placeholder");
    empty.textContent = t("web.settings.no_mcp");
    list.appendChild(empty);
  }
  (data.mcp || []).forEach((m) => {
    const line = el("div", "list-line");
    const on = m.status !== "disabled";
    const toggle = makeToggle(on, (next) => {
      api("/api/mcp/" + encodeURIComponent(m.id || m.name), {
        method: "POST",
        body: { enabled: next },
      }).then(async (r) => {
        if (r.ok && r.data && r.data.ok) {
          setIndicator(t("web.settings.mcp_saved"), false);
          await loadPlugins();
        } else {
          setIndicator(t("web.settings.save_failed"), true);
        }
      });
    });
    toggle.title = on ? t("web.settings.mcp_disable") : t("web.settings.mcp_enable");
    toggle.setAttribute("aria-label", toggle.title);
    line.appendChild(toggle);
    const nameEl = el("span", "name", m.name);
    nameEl.title = m.name;
    line.appendChild(nameEl);
    line.appendChild(el("span", "st", m.status || "—"));
    line.appendChild(chip(t("web.settings.edit"), "", () => openMcpForm("edit", m)));
    line.appendChild(chip(t("web.settings.delete"), "danger", async () => {
      const r = await api("/api/mcp/" + encodeURIComponent(m.id || m.name), { method: "DELETE" });
      if (r.ok && r.data && r.data.ok) {
        setIndicator(t("web.settings.mcp_saved"), false);
        await loadPlugins();
      } else {
        setIndicator((r.data && r.data.error) || t("web.settings.delete_failed"), true);
      }
    }));
    list.appendChild(line);
  });
  if (S.state.mcpForm) list.appendChild(mcpForm());
  if ((data.mcp || []).length) {
    const mnote = el("div", "settings-note");
    mnote.textContent = t("web.settings.mcp_note");
    list.appendChild(mnote);
  }
  renderLspSection(list);
  container.appendChild(list);
}

// Inline MCP add/edit form. Secrets are never echoed by the API, so env/headers
// start blank — leaving them blank on edit keeps the stored values (patch
// semantics: absent keys are not touched).
function mcpLiteralField(label, input) {
  const f = el("div", "pform-field");
  const lab = el("label", "", label);
  f.appendChild(lab);
  input.setAttribute("aria-label", label);
  f.appendChild(input);
  return f;
}

function mcpForm() {
  const mode = (S.state.mcpForm && S.state.mcpForm.mode) || "add";
  const editing = (S.state.mcpForm && S.state.mcpForm.entry) || {};
  const box = el("div", "pform");
  const grid = el("div", "pform-grid");
  const fName = providerInput(editing.name || "", "text", "my-server");
  const fTransport = providerSelect(["stdio", "sse", "http"], editing.transport || "stdio");
  const fCommand = providerInput(editing.command || "", "text", "npx");
  const fUrl = providerInput(editing.url || "", "text", "https://…");
  grid.appendChild(mcpLiteralField("name", fName));
  grid.appendChild(mcpLiteralField("transport", fTransport));
  grid.appendChild(mcpLiteralField("command", fCommand));
  grid.appendChild(mcpLiteralField("url", fUrl));
  box.appendChild(grid);
  const adv = el("details", "pform-adv");
  adv.appendChild(el("summary", "", t("web.settings.provider_advanced")));
  const fArgs = providerInput(editing.args ? JSON.stringify(editing.args) : "", "text", '["--stdio"]');
  const fTimeout = providerInput(editing.timeout != null ? String(editing.timeout) : "", "number", "30000");
  const fEnabled = providerCheck(editing.enabled !== false);
  adv.appendChild(mcpLiteralField("args (JSON)", fArgs));
  adv.appendChild(mcpLiteralField("timeout (ms)", fTimeout));
  const envKeys = Array.isArray(editing.envKeys) ? editing.envKeys : [];
  const headerKeys = Array.isArray(editing.headerKeys) ? editing.headerKeys : [];
  const fEnv = el("textarea");
  fEnv.placeholder = envKeys.length ? "stored: " + envKeys.join(", ") + " — blank keeps" : '{"TOKEN": "…"}';
  const fHeaders = el("textarea");
  fHeaders.placeholder = headerKeys.length ? "stored: " + headerKeys.join(", ") + " — blank keeps" : '{"Authorization": "…"}';
  adv.appendChild(mcpLiteralField("env (JSON)", fEnv));
  adv.appendChild(mcpLiteralField("headers (JSON)", fHeaders));
  adv.appendChild(mcpLiteralField("enabled", fEnabled));
  box.appendChild(adv);
  const f = { name: fName, transport: fTransport, command: fCommand, url: fUrl, args: fArgs, timeout: fTimeout, env: fEnv, headers: fHeaders, enabled: fEnabled };
  const actions = el("div", "pform-actions");
  actions.appendChild(link(t("web.settings.save"), "", () => submitMcpForm(f, mode, editing)));
  actions.appendChild(link(t("web.settings.cancel"), "dim", () => closeSubDialog()));
  box.appendChild(actions);
  return box;
}

/** Open the MCP add/edit nested dialog. */
function openMcpForm(mode, entry) {
  S.state.mcpForm = { mode, entry: entry || null };
  openSubDialog(
    t(mode === "edit" ? "web.settings.mcp_edit_title" : "web.settings.mcp_add"),
    mcpForm(),
    () => {
      S.state.mcpForm = null;
      renderPluginsPanel();
      void loadPlugins();
    },
  );
}

function parseJsonMap(raw) {
  const text = raw.trim();
  if (!text) return { present: false, value: null };
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { present: true, value: null };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { present: true, value: null };
  if (!Object.values(parsed).every((v) => typeof v === "string")) return { present: true, value: null };
  return { present: true, value: parsed };
}

async function submitMcpForm(f, mode, editing) {
  const name = f.name.value.trim();
  const transport = f.transport.value || "stdio";
  const command = f.command.value.trim();
  const url = f.url.value.trim();
  if (!name || (transport === "stdio" ? !command : !url)) {
    setIndicator(t("web.settings.mcp_required"), true);
    return;
  }
  const body = { name, transport };
  if (command) body.command = command;
  if (url) body.url = url;
  const argsRaw = f.args.value.trim();
  if (argsRaw) {
    let args = null;
    try {
      args = JSON.parse(argsRaw);
    } catch {
      args = null;
    }
    if (!Array.isArray(args) || !args.every((x) => typeof x === "string")) {
      setIndicator(t("web.settings.mcp_invalid"), true);
      return;
    }
    body.args = args;
  }
  for (const key of ["env", "headers"]) {
    const parsed = parseJsonMap(f[key].value);
    if (parsed.present && !parsed.value) {
      setIndicator(t("web.settings.mcp_invalid"), true);
      return;
    }
    if (parsed.present) body[key] = parsed.value;
  }
  const timeoutRaw = f.timeout.value.trim();
  if (timeoutRaw) {
    const n = Number(timeoutRaw);
    if (!Number.isInteger(n) || n < 1000 || n > 300000) {
      setIndicator(t("web.settings.mcp_invalid"), true);
      return;
    }
    body.timeout = n;
  }
  body.enabled = f.enabled.checked;
  const target = mode === "edit" ? "/api/mcp/" + encodeURIComponent(editing.id || editing.name) : "/api/mcp";
  const r = await api(target, { method: mode === "edit" ? "PUT" : "POST", body });
  if (r.ok && r.data && r.data.ok) {
    setIndicator(t("web.settings.mcp_saved"), false);
    closeSubDialog();
  } else {
    setIndicator((r.data && r.data.error) || t("web.settings.save_failed"), true);
  }
}

function renderLspSection(list) {
  const servers = S.state.lsp;
  list.appendChild(groupHeader(t("web.settings.lsp_servers"), Array.isArray(servers) ? servers.length : null));
  if (servers === undefined || servers === null) {
    list.appendChild(placeholderFor(servers, t("web.settings.lsp_unavailable")));
    return;
  }
  if (!servers.length) {
    const empty = el("div", "placeholder");
    empty.textContent = t("web.settings.no_lsp");
    list.appendChild(empty);
  }
  servers.forEach((entry) => {
    const line = el("div", "list-line");
    line.appendChild(el("span", entry.enabled ? "g" : "dim", entry.enabled ? "✓" : "○"));
    const nameEl = el("span", "name", entry.lang);
    nameEl.title = entry.lang;
    line.appendChild(nameEl);
    const meta = [entry.command, entry.timeout != null ? entry.timeout + " ms" : null].filter(Boolean).join(" · ");
    if (meta) line.appendChild(el("span", "src", meta));
    line.appendChild(el("span", "st", entry.enabled ? t("web.settings.enabled") : t("web.settings.disabled")));
    line.appendChild(chip(t("web.settings.edit"), "", () => openLspForm(entry)));
    list.appendChild(line);
  });
  if (servers.length) {
    const note = el("div", "settings-note");
    note.textContent = t("web.settings.lsp_note");
    list.appendChild(note);
  }
}

/** Open the LSP server edit nested dialog. */
function openLspForm(entry) {
  S.state.lspForm = { lang: entry.lang, entry };
  openSubDialog(entry.lang, lspForm(), () => {
    S.state.lspForm = null;
    renderPluginsPanel();
    void loadLsp();
  });
}

// LSP server edit form (enabled toggle, timeout, command, args JSON).
function lspForm() {
  const editing = (S.state.lspForm && S.state.lspForm.entry) || {};
  const lang = (S.state.lspForm && S.state.lspForm.lang) || editing.lang || "";
  const box = el("div", "pform");
  const grid = el("div", "pform-grid");
  const fCommand = providerInput(editing.command || "", "text", "npx");
  const fTimeout = providerInput(editing.timeout != null ? String(editing.timeout) : "", "number", "30000");
  const fEnabled = providerCheck(editing.enabled !== false);
  grid.appendChild(mcpLiteralField("command", fCommand));
  grid.appendChild(mcpLiteralField("timeout (ms)", fTimeout));
  grid.appendChild(mcpLiteralField("enabled", fEnabled));
  box.appendChild(grid);
  const fArgs = el("textarea");
  fArgs.value = editing.args ? JSON.stringify(editing.args) : "";
  fArgs.placeholder = '["--stdio"]';
  box.appendChild(mcpLiteralField("args (JSON)", fArgs));
  const actions = el("div", "pform-actions");
  actions.appendChild(link(t("web.settings.save"), "", async () => {
    const body = {};
    const command = fCommand.value.trim();
    if (command) body.command = command;
    const timeoutRaw = fTimeout.value.trim();
    if (timeoutRaw) {
      const n = Number(timeoutRaw);
      if (!Number.isInteger(n) || n < 1000 || n > 300000) {
        setIndicator(t("web.settings.provider_invalid"), true);
        return;
      }
      body.timeout = n;
    }
    const argsRaw = fArgs.value.trim();
    if (argsRaw) {
      let args = null;
      try {
        args = JSON.parse(argsRaw);
      } catch {
        args = null;
      }
      if (!Array.isArray(args) || !args.every((x) => typeof x === "string")) {
        setIndicator(t("web.settings.provider_invalid"), true);
        return;
      }
      body.args = args;
    }
    body.enabled = fEnabled.checked;
    const r = await api("/api/lsp/" + encodeURIComponent(lang), { method: "PUT", body });
    if (r.ok && r.data && r.data.ok) {
      setIndicator(t("web.settings.mcp_saved"), false);
      closeSubDialog();
    } else {
      setIndicator((r.data && r.data.error) || t("web.settings.save_failed"), true);
    }
  }));
  actions.appendChild(link(t("web.settings.cancel"), "dim", () => closeSubDialog()));
  box.appendChild(actions);
  return box;
}

export async function loadLsp() {
  const r = await api("/api/lsp");
  S.state.lsp = r.ok && r.data && Array.isArray(r.data.servers) ? r.data.servers : null;
  renderPluginsPanel();
}

export async function loadMemory() {
  const r = await api("/api/memory");
  S.state.memory = r.ok && r.data ? r.data : null;
  renderMemoryPanel();
}

export async function loadSkills() {
  const r = await api("/api/skills");
  S.state.skills = r.ok && r.data && Array.isArray(r.data.skills) ? r.data.skills : null;
  renderSkillsPanel();
}

export async function loadPlugins() {
  const r = await api("/api/plugins");
  S.state.pluginsData =
    r.ok && r.data
      ? { plugins: r.data.plugins || [], mcp: r.data.mcp || [] }
      : null;
  renderPluginsPanel();
}

export function renderSettings() {
  // Generic panels render straight from PANEL_SECTIONS; custom panels
  // (model/ui/memory/skills/plugins/security) append their sections themselves
  // or render bespoke widgets alongside.
  for (const panel of ["general", "context", "reasoning", "agent", "network", "browser", "sessions", "advanced"]) {
    renderPanel(panel);
  }
  renderModelPanel();
  renderUiPanel();
  renderMemoryPanel();
  renderSkillsPanel();
  renderPluginsPanel();
  renderSecurityPanel();
}

const overlay = document.getElementById("overlay");
const settingsBtn = document.getElementById("openSettings");
const closeSettingsBtn = document.getElementById("closeSettings");
let settingsReturnFocus = null;

// Settings sections act as a real tablist: roles, roving tabindex, arrow keys.
const settingsTabs = Array.from(document.querySelectorAll("#setMenu .mi"));
function selectSettingsPanel(name) {
  settingsTabs.forEach((x) => {
    const on = x.dataset.p === name;
    x.classList.toggle("on", on);
    x.setAttribute("aria-selected", on ? "true" : "false");
    x.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll(".content-col .panel").forEach((x) => x.classList.remove("on"));
  const panel = document.getElementById("p-" + name);
  if (panel) panel.classList.add("on");
}
settingsTabs.forEach((mi) => {
  const name = mi.dataset.p;
  mi.setAttribute("role", "tab");
  mi.setAttribute("id", "tab-" + name);
  mi.setAttribute("aria-controls", "p-" + name);
  mi.setAttribute("aria-selected", mi.classList.contains("on") ? "true" : "false");
  mi.tabIndex = mi.classList.contains("on") ? 0 : -1;
  mi.addEventListener("click", () => selectSettingsPanel(name));
  mi.addEventListener("keydown", (e) => {
    const i = settingsTabs.indexOf(mi);
    let next = null;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") next = settingsTabs[(i + 1) % settingsTabs.length];
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = settingsTabs[(i - 1 + settingsTabs.length) % settingsTabs.length];
    else if (e.key === "Home") next = settingsTabs[0];
    else if (e.key === "End") next = settingsTabs[settingsTabs.length - 1];
    if (next) {
      e.preventDefault();
      selectSettingsPanel(next.dataset.p);
      next.focus();
    }
  });
});
document.querySelectorAll(".content-col .panel").forEach((panel) => {
  panel.setAttribute("role", "tabpanel");
  panel.setAttribute("aria-labelledby", "tab-" + panel.id.replace(/^p-/, ""));
});

// ---- settings search -------------------------------------------------------
// With 100+ keys, scanning a sidebar is slower than typing. The index is the
// same PANEL_SECTIONS table that renders the panels (plus each key's i18n
// label/description), so search can never disagree with the layout.
const setMenuEl = document.getElementById("setMenu");
const setSearch = document.getElementById("setSearch");
const setSearchClear = document.getElementById("setSearchClear");
const setSearchIcon = document.getElementById("setSearchIcon");
const setResults = document.getElementById("setResults");
if (setSearchIcon) setSearchIcon.appendChild(icon("search", "set-search-svg"));

function searchIndex() {
  const owner = keyToPanel();
  return (S.state.registry || [])
    .filter((def) => def && typeof def.key === "string")
    .map((def) => {
      const label = configLabel(def);
      return {
        def,
        panel: owner.get(def.key) || null,
        label,
        desc: descFor(def.key),
        haystack: `${label} ${def.key} ${descFor(def.key)}`.toLowerCase(),
      };
    })
    .filter((e) => e.panel);
}

let searchRows = [];
let searchCursor = -1;

function closeSearch() {
  if (setSearch) setSearch.value = "";
  if (setResults) {
    setResults.hidden = true;
    setResults.textContent = "";
  }
  if (setMenuEl) setMenuEl.hidden = false;
  if (setSearchClear) setSearchClear.hidden = true;
  searchRows = [];
  searchCursor = -1;
}

function flashRow(panel, key) {
  const panelEl = document.getElementById("p-" + panel);
  if (!panelEl) return;
  const rows = Array.from(panelEl.querySelectorAll(".row"));
  const def = defFor(key);
  if (!def) return;
  const label = configLabel(def);
  const target = rows.find((r) => {
    const nameEl = r.querySelector(".row-name");
    return nameEl && nameEl.textContent === label;
  });
  if (!target) return;
  target.scrollIntoView({ block: "center" });
  target.classList.add("row-flash");
  setTimeout(() => target.classList.remove("row-flash"), 1200);
}

function pickResult(entry) {
  if (!entry || !entry.panel) return;
  closeSearch();
  selectSettingsPanel(entry.panel);
  flashRow(entry.panel, entry.def.key);
}

function renderResults(query) {
  if (!setResults) return;
  const q = query.trim().toLowerCase();
  if (!q) {
    closeSearch();
    return;
  }
  const matches = searchIndex().filter((e) => e.haystack.includes(q));
  setResults.textContent = "";
  if (!matches.length) {
    const empty = el("div", "set-results-empty", t("web.settings.search_empty"));
    setResults.appendChild(empty);
  }
  searchRows = matches.slice(0, 40);
  searchCursor = searchRows.length ? 0 : -1;
  searchRows.forEach((entry, i) => {
    const item = el("div", "set-result" + (i === searchCursor ? " on" : ""));
    item.setAttribute("role", "option");
    item.tabIndex = -1;
    item.appendChild(el("span", "sr-label", entry.label));
    const panelName = t("web.settings." + entry.panel);
    item.appendChild(el("span", "sr-panel", panelName === "web.settings." + entry.panel ? entry.panel : panelName));
    const keyEl = el("span", "sr-key", entry.def.key);
    keyEl.title = entry.def.key;
    item.appendChild(keyEl);
    item.addEventListener("click", () => pickResult(entry));
    setResults.appendChild(item);
  });
  setResults.hidden = false;
  setMenuEl.hidden = true;
  setSearchClear.hidden = false;
}

function moveSearchCursor(delta) {
  if (!searchRows.length) return;
  searchCursor = (searchCursor + delta + searchRows.length) % searchRows.length;
  Array.from(setResults.children).forEach((node, i) => node.classList.toggle("on", i === searchCursor));
  const active = setResults.children[searchCursor];
  if (active) active.scrollIntoView({ block: "nearest" });
}

if (setSearch) {
  setSearch.addEventListener("input", () => renderResults(setSearch.value));
  setSearch.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveSearchCursor(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveSearchCursor(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pickResult(searchRows[searchCursor]);
    } else if (e.key === "Escape" && setSearch.value) {
      // First Esc clears the query; a second one is handled globally (close).
      e.stopPropagation();
      closeSearch();
    }
  });
}
if (setSearchClear) setSearchClear.addEventListener("click", closeSearch);

function openSettings() {
  settingsReturnFocus = document.activeElement;
  overlay.classList.add("open");
  settingsBtn.setAttribute("aria-expanded", "true");
  void loadMemory();
  void loadSkills();
  void loadPlugins();
  void loadLsp();
  const active = document.querySelector("#setMenu .mi.on") || settingsTabs[0];
  if (active) setTimeout(() => active.focus(), 0);
}
function closeSettings() {
  closeSubDialog();
  S.state.providerForm = null;
  S.state.mcpForm = null;
  S.state.lspForm = null;
  overlay.classList.remove("open");
  settingsBtn.setAttribute("aria-expanded", "false");
  if (settingsReturnFocus && settingsReturnFocus.focus) settingsReturnFocus.focus();
  settingsReturnFocus = null;
}
settingsBtn.addEventListener("click", openSettings);
closeSettingsBtn.addEventListener("click", closeSettings);
overlay.addEventListener("click", (e) => {
  if (e.target === overlay) closeSettings();
});
// Trap Tab inside the dialog while it is open.
overlay.addEventListener("keydown", (e) => trapTab(overlay, e));
// One nested dialog for every "edit a single thing" flow (provider, MCP
// server, LSP server). Keeps the settings modal visible behind it, traps Tab
// and returns focus to the control that opened it.
const subOverlay = document.getElementById("subOverlay");
const subHost = document.getElementById("subHost");
const subTitle = document.getElementById("subTitle");
const closeSubBtn = document.getElementById("closeSub");
let subReturnFocus = null;
let subOnClose = null;

export function isSubDialogOpen() {
  return !!subOverlay && subOverlay.classList.contains("open");
}

/** Open the nested dialog with a built content node. `onClose` runs after. */
export function openSubDialog(title, node, onClose) {
  if (!subOverlay || !subHost) return;
  subReturnFocus = document.activeElement;
  subOnClose = onClose || null;
  subTitle.textContent = title;
  subHost.textContent = "";
  subHost.appendChild(node);
  subOverlay.classList.add("open");
  setTimeout(() => {
    const first = subHost.querySelector("input, select, textarea");
    if (first) first.focus();
  }, 0);
}

export function closeSubDialog() {
  if (!isSubDialogOpen()) return;
  subOverlay.classList.remove("open");
  const after = subOnClose;
  subOnClose = null;
  if (subReturnFocus && subReturnFocus.focus) subReturnFocus.focus();
  subReturnFocus = null;
  if (after) after();
}

if (subOverlay) {
  if (closeSubBtn) closeSubBtn.addEventListener("click", closeSubDialog);
  subOverlay.addEventListener("click", (e) => {
    e.stopPropagation();
    if (e.target === subOverlay) closeSubDialog();
  });
  subOverlay.addEventListener("keydown", (e) => trapTab(subOverlay, e));
}

function openProviderForm(mode, entry) {
  S.state.providerForm = { mode, entry: entry || null };
  openSubDialog(
    t(mode === "edit" ? "web.settings.provider_edit_title" : "web.settings.provider_add_title"),
    providerForm(),
    () => renderModelPanel(),
  );
}

function closeProviderForm() {
  S.state.providerForm = null;
  closeSubDialog();
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (isSubDialogOpen()) closeSubDialog();
  else if (confirmOverlay && confirmOverlay.classList.contains("open")) closeConfirm();
  else if (overlay.classList.contains("open")) closeSettings();
});

export function currentTheme() {
  return localStorage.getItem(THEME_KEY) || "auto";
}

export function applyTheme(theme) {
  localStorage.setItem(THEME_KEY, theme);
  const light = theme === "light" || (theme === "auto" && window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);
  document.body.classList.toggle("light", !!light);
  renderUiPanel();
}

if (window.matchMedia) {
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (currentTheme() === "auto") applyTheme("auto");
  });
}
