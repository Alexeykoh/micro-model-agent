// Provider add/edit form. The "Model & provider" panel itself lives in
// `settings/model-panel.ts` and receives this module's list helpers through
// `initModelPanel` (keeps both files under the 300-line ceiling, no cycle).
// Shared form primitives come from `settings/form.js`; writes go through
// `settings/write.js`.
import { el, link } from "../dom.js";
import { api } from "../api.js";
import { t } from "../i18n.js";
import { settings } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { openConfirm, setIndicator } from "../dialog.js";
import { loadConfig } from "./write.js";
import { pfield, providerInput } from "./form.js";
import { providerTypeField } from "./provider-type-field.js";
import { openSubDialog, closeSubDialog } from "./subdialog.js";
import {
  providerBaseField,
  providerPresetField,
  wirePresetSync,
  providerAdvancedFields,
  PROVIDER_TYPES,
} from "./providers-form.js";
import type { CacheFlag } from "./providers-form.js";
import { initModelPanel, renderModelPanel } from "./model-panel.js";

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
      unlistedModels: e.unlistedModels,
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
  body.unlistedModels = String(f.unlisted.value || "")
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean);
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
  const fType = providerTypeField(PROVIDER_TYPES, editing.type);
  const fLabel = providerInput(editing.label, "text", "my-provider");
  const fBase = providerBaseField(editing.baseUrl);
  const fKey = providerInput("", "password", editing.hasApiKey ? t("web.settings.provider_key_keep") : "");
  const typeField = pfield("web.settings.provider_type", fType.node);
  fType.setAttribute("aria-label", t("web.settings.provider_type"));
  grid.appendChild(typeField);
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

async function deleteProvider(name: string): Promise<void> {
  const r = await api<Dict>("/api/providers/" + encodeURIComponent(name), { method: "DELETE" });
  if (r.ok && r.data && r.data.ok) {
    setIndicator(t("web.settings.saved"));
    await loadProviders();
    await loadConfig();
    return;
  }
  const err = (r.data && r.data.error) || t("web.settings.delete_failed");
  setIndicator(err === "active-provider" ? t("web.settings.provider_active_guard") : String(err), true);
}

// Deleting a provider writes config and reconfigures the runtime — ask first.
// Lives here (not in the panel) so the panel stays a dumb list renderer.
function confirmDeleteProvider(name: string): void {
  openConfirm({
    title: t("web.settings.provider_delete_confirm_title"),
    body: t("web.settings.provider_delete_confirm_body", { name }),
    acceptLabel: t("web.settings.delete"),
    cancelLabel: t("web.settings.cancel"),
    onAccept: () => void deleteProvider(name),
  });
}

initModelPanel({
  entries: providerEntries,
  providerName,
  providerMeta,
  openForm: openProviderForm,
  deleteProvider: confirmDeleteProvider,
});
export { renderModelPanel };
