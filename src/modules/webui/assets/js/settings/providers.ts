// Provider add/edit form + the "Model & provider" settings panel.
// Extracted from `settings.js`. Shared form primitives come from
// `settings/form.js`, generic section helpers from `settings/panels.js`; the
// write funnel from `settings/write.js`.
import { el, icon, link } from "../dom.js";
import { api } from "../api.js";
import { t } from "../i18n.js";
import { settings } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { contextLabel } from "../format.js";
import { setIndicator } from "../dialog.js";
import { PANEL_SECTIONS } from "./controls.js";
import { postConfig, loadConfig } from "./write.js";
import { settingsSection, chip, renderSections } from "./panels.js";
import { pfield, providerInput, providerSelect, providerCheck } from "./form.js";
import { openSubDialog, closeSubDialog } from "./subdialog.js";

function providerEntries(): Dict[] {
  if (settings.providers && Array.isArray(settings.providers.entries) && settings.providers.entries.length) {
    return settings.providers.entries;
  }
  const provider: Dict = (settings.config && settings.config.provider) || {};
  if (Array.isArray(provider.entries) && provider.entries.length) {
    return provider.entries.map((e: Dict) => ({
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

function providerName(p: Dict): string {
  return p.label || p.type || "—";
}

function providerMeta(p: Dict): string {
  const parts = [p.type];
  if (p.contextWindow) parts.push(Math.round(p.contextWindow / 1024) + "K");
  if (typeof p.rpm === "number" || typeof p.parallel === "number") {
    parts.push("rpm " + (p.rpm == null ? "—" : p.rpm) + " · x" + (p.parallel == null ? "—" : p.parallel));
  }
  return parts.join(" · ");
}

interface BaseField {
  node: HTMLElement;
  sel: HTMLSelectElement;
  custom: HTMLInputElement;
  value: string;
  addEventListener(ev: string, fn: EventListenerOrEventListenerObject): void;
  setAttribute(k: string, v: string): void;
}

// Base-URL field: a dropdown of well-known URLs plus a "custom URL" option
// revealing a free-text input, so corporate proxies stay enterable.
// Exposes a `.value` get/set compatible with plain inputs, plus the raw
// `sel`/`custom` nodes for event wiring.
function providerBaseField(value: unknown): BaseField {
  const node = el("div", "pform-base");
  const sel = el("select");
  PROVIDER_BASE_URLS.forEach(([label, url]) => {
    const o = el("option", "", label + " — " + url);
    o.value = url;
    sel.appendChild(o);
  });
  const customOpt = el("option", "", t("web.settings.provider_baseurl_custom"));
  customOpt.value = BASE_URL_CUSTOM;
  sel.appendChild(customOpt);
  const custom = providerInput("", "text", "https://…");
  const known = new Set(PROVIDER_BASE_URLS.map(([, url]) => url));
  const sync = () => {
    custom.style.display = sel.value === BASE_URL_CUSTOM ? "" : "none";
  };
  const field: BaseField = {
    node,
    sel,
    custom,
    get value() {
      return sel.value === BASE_URL_CUSTOM ? custom.value : sel.value;
    },
    set value(v: string) {
      if (v && known.has(v)) {
        sel.value = v;
      } else {
        sel.value = BASE_URL_CUSTOM;
        custom.value = v || "";
      }
      sync();
    },
    addEventListener(ev, fn) {
      sel.addEventListener(ev, fn);
      custom.addEventListener(ev, fn);
    },
    setAttribute(k, v) {
      sel.setAttribute(k, v);
    },
  };
  field.value = value ? String(value) : "";
  sel.addEventListener("change", sync);
  node.appendChild(sel);
  node.appendChild(custom);
  return field;
}

const CACHE_FLAG_KEYS = [
  "sessionHeader",
  "requestCachePrompt",
  "requestPromptCacheKey",
  "requestSessionId",
  "requestCacheControl",
  "requestStreamUsage",
];

// Known provider types (mirrors BUILTIN_PROVIDERS in src/modules/providers/presets.ts)
// and well-known local base URLs. Both render as real `<select>` dropdowns —
// `datalist` hints were replaced because they don't read as a list and behave
// inconsistently across browsers.
const PROVIDER_TYPES = [
  "openai-compat",
  "lmstudio",
  "openrouter",
  "openai",
  "anthropic",
  "opencode-zen",
  "opencode-go",
];

const PROVIDER_BASE_URLS: Array<[string, string]> = [
  ["LM Studio", "http://localhost:1234/v1"],
  ["Ollama", "http://localhost:11434/v1"],
  ["OpenRouter", "https://openrouter.ai/api/v1"],
  ["OpenAI", "https://api.openai.com/v1"],
  ["Anthropic", "https://api.anthropic.com"],
];

const BASE_URL_CUSTOM = "__custom__";

interface PresetField {
  presets: Dict[];
  sel: HTMLSelectElement | null;
  node: HTMLElement | null;
}

// One-click preset row: selecting a builtin fills type/label/base URL, so
// hosted providers need no URL knowledge. `custom` leaves the fields free.
// Returns the row node (null when no presets) plus the raw select for wiring.
function providerPresetField(editing: Dict): PresetField {
  const presets = settings.providerPresets || [];
  if (!presets.length) return { presets, sel: null, node: null };
  const sel = el("select", "pform-preset");
  const custom = el("option", "", t("web.settings.provider_custom"));
  custom.value = "";
  sel.appendChild(custom);
  presets.forEach((p: Dict) => {
    const o = el("option", "", p.label || p.type);
    o.value = p.id;
    sel.appendChild(o);
  });
  const match =
    presets.find((p: Dict) => p.type === editing.type && p.baseUrl && p.baseUrl === editing.baseUrl) ||
    presets.find((p: Dict) => p.type === editing.type && !p.baseUrl) ||
    presets.find((p: Dict) => p.type === editing.type);
  if (match) sel.value = match.id;
  return { presets, sel, node: pfield("web.settings.provider_preset", sel) };
}

// Keep the preset select and the type field in sync both ways.
function wirePresetSync(
  presets: Dict[],
  presetSel: HTMLSelectElement | null,
  mode: string,
  f: { type: HTMLSelectElement; label: HTMLInputElement; base: BaseField },
): void {
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
  // The type control is a `<select>`: some browsers fire only `change`.
  f.type.addEventListener("change", () => {
    const sel = presets.find((x) => x.id === presetSel.value);
    if (!sel || f.type.value.trim() !== sel.type) presetSel.value = "";
  });
}

interface CacheFlag {
  key: string;
  box: HTMLInputElement;
  node: HTMLElement;
}

// Optional tuning fields stay collapsed so the form reads as "type + URL".
function providerAdvancedFields(editing: Dict) {
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
    cacheFlags: [] as CacheFlag[],
  };
  // Flags keep the raw config key in `title` so it stays searchable, but the
  // visible label is localized like every other field of the form.
  f.cacheFlags = CACHE_FLAG_KEYS.map((key) => {
    const box = providerCheck(cache[key]);
    const label = t("web.settings.provider_flag." + key);
    box.setAttribute("aria-label", label);
    const wrap = el("label", "pform-check");
    wrap.title = key;
    wrap.appendChild(box);
    wrap.appendChild(el("span", "", label));
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

  // Retry numbers reuse the field grid (label above input) — a bare label+input
  // pair collapses into an unreadable inline blob without the grid styles.
  const retryGroup = el("div", "pform-checks");
  retryGroup.appendChild(el("span", "pform-checks-title", t("web.settings.provider_retry")));
  const retryGrid = el("div", "pform-grid");
  retryGrid.appendChild(pfield("web.settings.provider_retry_max", f.retryMax));
  retryGrid.appendChild(pfield("web.settings.provider_retry_base", f.retryBase));
  retryGrid.appendChild(pfield("web.settings.provider_retry_maxdelay", f.retryMaxD));
  retryGroup.appendChild(retryGrid);
  adv.appendChild(retryGroup);

  const flagGroup = el("div", "pform-checks");
  flagGroup.appendChild(el("span", "pform-checks-title", t("web.settings.provider_cache_flags")));
  const flagGrid = el("div", "pform-checks-grid");
  f.cacheFlags.forEach(({ node }) => flagGrid.appendChild(node));
  flagGroup.appendChild(flagGrid);
  adv.appendChild(flagGroup);
  return { node: adv, ...f };
}

// Validate the field bag, POST it, and refresh the panels on success.
async function submitProviderForm(f: Dict, mode: string, editing: Dict): Promise<void> {
  const type = f.type.value.trim();
  const baseUrl = f.base.value.trim();
  if (!type || !baseUrl) {
    setIndicator(t("web.settings.provider_required"), true);
    return;
  }
  const body: Dict = { type, baseUrl };
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
  const nums: Array<[string, HTMLInputElement, number, number?]> = [
    ["contextWindow", f.ctx, 1024],
    ["priority", f.prio, 0],
    ["rpm", f.rpm, 1],
    ["parallel", f.par, 1],
    ["maxCompletionTokens", f.maxTokens, 512, 128000],
    ["maxRetries", f.retryMax, 0, 10],
    ["baseDelay", f.retryBase, 0, 60000],
    ["maxDelay", f.retryMaxD, 0, 300000],
  ];
  const retry: Dict = {};
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
  const cache: Dict = {};
  if (f.cacheMech.value) cache.mechanism = f.cacheMech.value;
  if (f.cacheReport.value) cache.report = f.cacheReport.value;
  const prevCache: Dict = (editing && editing.cache) || {};
  f.cacheFlags.forEach(({ key, box }: CacheFlag) => {
    if (box.checked !== (prevCache[key] === true)) cache[key] = box.checked;
  });
  if (Object.keys(cache).length) body.cache = cache;
  const r = await api<Dict>("/api/providers", { method: "POST", body });
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

function providerForm(): HTMLElement {
  const mode = (settings.providerForm && settings.providerForm.mode) || "add";
  const editing: Dict = (settings.providerForm && settings.providerForm.entry) || {};
  const box = el("div", "pform");

  const { presets, sel: presetSel, node: presetNode } = providerPresetField(editing);
  if (presetNode) box.appendChild(presetNode);

  const grid = el("div", "pform-grid");
  const fType = providerSelect(PROVIDER_TYPES, editing.type);
  const fLabel = providerInput(editing.label, "text", "my-provider");
  const fBase = providerBaseField(editing.baseUrl);
  const fKey = providerInput("", "password", editing.hasApiKey ? t("web.settings.provider_key_keep") : "");
  grid.appendChild(pfield("web.settings.provider_type", fType));
  grid.appendChild(pfield("web.settings.provider_label_field", fLabel));
  grid.appendChild(pfield("web.settings.provider_baseurl", fBase.node));
  grid.appendChild(pfield("web.settings.provider_apikey", fKey));
  box.appendChild(grid);
  wirePresetSync(presets, presetSel, mode, { type: fType, label: fLabel, base: fBase });

  const { node: advNode, ...advF } = providerAdvancedFields(editing);
  box.appendChild(advNode);
  const f: Dict = { type: fType, label: fLabel, base: fBase, key: fKey, ...advF };

  const actions = el("div", "pform-actions");
  actions.appendChild(link(t("web.settings.save"), "", () => void submitProviderForm(f, mode, editing)));
  actions.appendChild(link(t("web.settings.cancel"), "dim", () => closeProviderForm()));
  box.appendChild(actions);
  return box;
}

export function renderModelPanel(): void {
  const container = document.querySelector<HTMLElement>('[data-panel="model"]');
  if (!container) return;
  container.textContent = "";
  const cfg: Dict = settings.config || {};

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
    const models = settings.models.filter((m) => !q || String(m).toLowerCase().indexOf(q) !== -1);
    if (!models.length) {
      list.appendChild(el("div", "placeholder", settings.models.length ? t("web.settings.no_matches") : t("web.settings.no_models")));
      return;
    }
    models.forEach((m) => {
      const active = m === cfg.model;
      const item = el("div", "model-item" + (active ? " active" : ""));
      const nameEl = el("span", "m-name", String(m));
      nameEl.title = String(m);
      item.appendChild(nameEl);
      if (active) {
        item.appendChild(el("span", "m-meta", contextLabel() + " · " + t("web.settings.active_check")));
      } else {
        item.appendChild(chip(t("web.settings.use"), "", () => void postConfig("model", m, true)));
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
  const activeName = (settings.providers && settings.providers.active) || cfg.provider?.active || cfg.provider?.type || "—";
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
      actions.appendChild(chip(t("web.settings.provider_make_active"), "", () => void postConfig("provider.active", name, true)));
    }
    actions.appendChild(
      chip(t("web.settings.edit"), "", () => openProviderForm("edit", entry)),
    );
    if (!active) {
      actions.appendChild(
        chip(t("web.settings.delete"), "danger", async () => {
          const r = await api<Dict>("/api/providers/" + encodeURIComponent(name), { method: "DELETE" });
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

export async function loadProviders(): Promise<void> {
  const r = await api<Dict>("/api/providers");
  settings.providers = r.ok && r.data && Array.isArray(r.data.entries) ? r.data : undefined;
  settings.providerPresets = r.ok && r.data && Array.isArray(r.data.presets) ? r.data.presets : [];
  renderModelPanel();
}

function openProviderForm(mode: string, entry: Dict | null): void {
  settings.providerForm = { mode, entry: entry || null };
  openSubDialog(
    t(mode === "edit" ? "web.settings.provider_edit_title" : "web.settings.provider_add_title"),
    providerForm(),
    () => renderModelPanel(),
  );
}

function closeProviderForm(): void {
  settings.providerForm = null;
  closeSubDialog();
}
