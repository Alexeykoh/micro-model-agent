// Shared building blocks for the settings panels: localized labels, the generic
// registry-driven section card/rows and small list controls. Extracted from
// `panels.ts` (rule 6) so each bespoke panel file stays under the ceiling.
// Depends only downward: `settings/controls.js`, the write funnel and the
// provider/model option helpers.
import { el } from "../dom.js";
import { t } from "../i18n.js";
import { settings, getPath } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { controlFor } from "./controls.js";
import { postConfig } from "./write.js";
import { providerNameOptions } from "./provider-options.js";
import { modelOptionsFor, hasModelsFor, loadModelsFor } from "./models-by-provider.js";

// Localized label for a registry key: `config.key.<canonical>`, falling back
// to the raw key when no translation exists (so a new key is never blank).
export function configLabel(def: Dict): string {
  const k = "config.key." + def.key;
  const tr = t(k);
  return tr === k ? def.key : tr;
}

// Localized enum value: `config.enum.<value>`, falling back to the raw value.
// The raw value is still what gets POSTed — only the label is translated.
export function enumLabel(v: string): string {
  const k = "config.enum." + v;
  const tr = t(k);
  return tr === k ? v : tr;
}

export function defFor(key: string): Dict | null {
  return settings.registry.find((d) => d.key === key) || null;
}

export function row(label: string, control: string | Node | null, desc?: string): HTMLElement {
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

export function descFor(key: string): string {
  const k = "config.desc." + key;
  const d = t(k);
  return d === k ? "" : d;
}

// Generic per-type control (`settings/controls.js`): bool toggle, enum
// select, int/share/list/json inputs. `post` funnels through `postConfig`.
function configControl(def: Dict, key: string): HTMLElement {
  // Read-only keys carry their resolved value in the registry entry: the getter
  // is authoritative and may differ from the raw config field (`version`).
  const value =
    def.readOnly && def.value !== undefined
      ? def.value
      : settings.config
        ? getPath(settings.config, key)
        : undefined;
  return controlFor(def, value, {
    label: configLabel(def),
    enumLabel,
    emptyLabel: t("config.enum.none"),
    modelOptions: settings.models,
    providerOptions: providerNameOptions(),
    // Experts table: model list scoped to the row's provider entry.
    modelOptionsFor,
    hasModelsFor,
    loadModelsFor,
    fieldLabel: (k: string) => {
      const kk = "config.field." + k;
      const tr = t(kk);
      return tr === kk ? k : tr;
    },
    post: (v: unknown) => void postConfig(key, v, false),
  });
}

// One titled section card: uppercase title + optional one-line explanation,
// then its setting rows. Titles come from PANEL_SECTIONS so a section name can
// never drift from the keys under it.
function sectionCard(section: Dict): HTMLElement {
  const card = el("div", "settings-section");
  const head = el("div", "sec-head");
  head.appendChild(el("span", "sec-title", t(section.titleKey)));
  card.appendChild(head);
  if (section.descKey) {
    const d = t(section.descKey);
    if (d !== section.descKey) card.appendChild(el("div", "sec-desc", d));
  }
  const body = el("div", "sec-body");
  section.keys.forEach((key: string) => {
    const def = defFor(key);
    if (!def) return;
    body.appendChild(row(configLabel(def), configControl(def, key), descFor(def.key)));
  });
  card.appendChild(body);
  return card;
}

// Render the PANEL_SECTIONS table for a panel. Panels with custom bodies call
// this after their own content so bespoke widgets stay on top.
export function renderSections(panel: string, sections: Dict[]): void {
  const container = document.querySelector('[data-panel="' + panel + '"]');
  if (!container) return;
  sections.forEach((section) => container.appendChild(sectionCard(section)));
}

// A titled group inside a settings panel (models / providers).
export function settingsSection(titleKey: string): {
  el: HTMLElement;
  head: HTMLElement;
  body: HTMLElement;
} {
  const sec = el("div", "settings-section");
  const head = el("div", "sec-head");
  head.appendChild(el("span", "sec-title", t(titleKey)));
  sec.appendChild(head);
  const body = el("div", "sec-body");
  sec.appendChild(body);
  return { el: sec, head, body };
}

// Compact action control used inside list items (use / edit / delete).
export function chip(
  label: string,
  cls: string | null,
  onClick: (e: MouseEvent) => void,
): HTMLButtonElement {
  const b = el("button", "chip" + (cls ? " " + cls : ""), label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

export function placeholderFor(data: unknown, empty: string): HTMLElement {
  const d = el("div", "placeholder");
  if (data === undefined) d.textContent = t("web.settings.loading");
  else d.textContent = empty;
  return d;
}

export function groupHeader(label: string, count?: number | null): HTMLElement {
  const head = el("div", "row");
  head.appendChild(el("span", "val accent", label));
  if (count != null) head.appendChild(el("span", "val dim", String(count)));
  return head;
}
