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
import { pfield, providerInput, providerSelect } from "./form.js";
import { openSubDialog, closeSubDialog } from "./subdialog.js";
import {
  providerBaseField,
  providerPresetField,
  wirePresetSync,
  providerAdvancedFields,
  PROVIDER_TYPES,
} from "./providers-form.js";
import type { CacheFlag } from "./providers-form.js";

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
  const activeName = (cfg.provider && (cfg.provider.active || cfg.provider.type)) || (settings.providers && settings.providers.active) || "—";
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
