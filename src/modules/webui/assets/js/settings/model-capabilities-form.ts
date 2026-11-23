// Per-model capability editor: one popup form over config.modelCapabilities[model].
// Fields mirror ModelCapabilities (src/config/types.ts); labels come from the
// same config.field.* keys as the Capabilities table.
import { el, icon, makeToggle } from "../dom.js";
import { t } from "../i18n.js";
import { session, settings } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { closeSubDialog, openSubDialog } from "../subdialog.js";
import { postConfig } from "./write.js";

export interface CapabilityField {
  key: string;
  kind: "bool" | "enum" | "list";
  options?: string[];
}

// Mirror of the strategy enum in src/config/types.ts; keep both in sync.
export const CAPABILITY_FIELDS: CapabilityField[] = [
  { key: "vision", kind: "bool" },
  { key: "video", kind: "bool" },
  { key: "audio", kind: "bool" },
  { key: "pdf", kind: "bool" },
  { key: "tools", kind: "bool" },
  {
    key: "reasoningStrategy",
    kind: "enum",
    options: ["openai-effort", "template-kwarg", "prompt-tag", "none"],
  },
  { key: "reasoningOff", kind: "bool" },
  { key: "reasoningLevels", kind: "list" },
];

/** Reasoning levels offered by the multi-select popup. */
export const REASONING_LEVELS = [
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Whole-key value: replace one model's entry, keep every other override. */
export function buildModelCapabilities(
  all: Dict | undefined,
  model: string,
  form: Record<string, unknown>,
): Dict {
  const out: Dict = {};
  for (const [name, entry] of Object.entries(all ?? {})) {
    if (name === model) continue;
    if (entry && typeof entry === "object") out[name] = { ...(entry as Dict) };
  }
  const entry: Dict = {};
  for (const field of CAPABILITY_FIELDS) {
    const value = form[field.key];
    if (field.kind === "bool") {
      if (value === true) entry[field.key] = true;
    } else if (field.kind === "enum") {
      const text = typeof value === "string" ? value.trim() : "";
      if (text) entry[field.key] = text;
    } else {
      const levels = Array.isArray(value)
        ? value.map(String)
        : typeof value === "string"
          ? value.split(",").map((s) => s.trim()).filter(Boolean)
          : [];
      if (levels.length) entry[field.key] = levels;
    }
  }
  if (Object.keys(entry).length) out[model] = entry;
  return out;
}

/** Discovery hint: GET /api/models carries capabilities for the active model only. */
export function detectedHint(model: string): string | null {
  const cfg = settings.config;
  if (!cfg || cfg.model !== model) return null;
  const caps = session.capabilities;
  const reasoning = session.reasoning as Dict | undefined;
  const parts: string[] = [];
  for (const key of ["vision", "video", "audio", "pdf", "tools"] as const) {
    if (caps?.[key] === true) parts.push(key);
  }
  if (reasoning?.strategy && reasoning.strategy !== "none") {
    parts.push("reasoning: " + String(reasoning.strategy));
    if (Array.isArray(reasoning.levels) && reasoning.levels.length) {
      parts.push("levels: " + reasoning.levels.join("/"));
    }
  }
  return parts.length ? parts.join(" · ") : null;
}

/** Compact trigger placed on each row of the Models tab. */
export function capabilityEditButton(model: string): HTMLButtonElement {
  const button = el("button", "chip", t("web.settings.model_capabilities.edit"));
  button.type = "button";
  button.dataset.capEdit = "1";
  button.addEventListener("click", () => openModelCapabilitiesDialog(model));
  return button;
}

/** Button + popup of level checkboxes, replacing a free-form comma string. */
function reasoningLevelsField(
  model: string,
  key: string,
  label: string,
  initial: string[],
  form: Record<string, unknown>,
): HTMLElement {
  const wrap = el("div", "caps-levels");
  const chosen = new Set<string>(initial);
  const button = el("button", "caps-levels-btn");
  button.type = "button";
  button.setAttribute("aria-haspopup", "true");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-label", `${model}: ${label}`);
  const value = el("span", "caps-levels-value");
  const toggle = el("span", "tog");
  toggle.appendChild(icon("chevron-down"));
  button.append(value, toggle);

  const paint = (): void => {
    value.textContent = chosen.size
      ? [...chosen].join(", ")
      : t("web.settings.model_capabilities.levels.none");
  };
  form[key] = [...chosen];
  const popup = el("div", "caps-levels-pop");
  popup.hidden = true;
  for (const level of REASONING_LEVELS) {
    const row = el("div", "caps-levels-row");
    row.appendChild(el("span", "caps-levels-name", level));
    const sw = makeToggle(chosen.has(level), (next) => {
      if (next) chosen.add(level);
      else chosen.delete(level);
      form[key] = [...chosen];
      paint();
      return true;
    });
    sw.dataset.level = level;
    sw.setAttribute("aria-label", level);
    row.appendChild(sw);
    popup.appendChild(row);
  }
  button.addEventListener("click", () => {
    popup.hidden = !popup.hidden;
    button.setAttribute("aria-expanded", popup.hidden ? "false" : "true");
  });
  paint();
  wrap.append(button, popup);
  return wrap;
}

/** Open the nested dialog for one model. Save/Reset post once, then close. */
export function openModelCapabilitiesDialog(model: string): void {
  const all = (settings.config?.modelCapabilities ?? {}) as Dict;
  const stored = all[model];
  const current: Dict = stored && typeof stored === "object" ? { ...(stored as Dict) } : {};
  const form: Record<string, unknown> = {};
  const body = el("div", "caps-form");

  const hint = detectedHint(model);
  if (hint) {
    body.appendChild(
      el("div", "p-meta", t("web.settings.model_capabilities.detected", { values: hint })),
    );
  }

  const note = el("div", "caps-note");
  note.appendChild(icon("info"));
  note.appendChild(el("span", "", t("web.settings.model_capabilities.note")));
  body.appendChild(note);

  const groups: Array<{ title: string; fields: typeof CAPABILITY_FIELDS }> = [
    {
      title: t("web.settings.model_capabilities.group.capabilities"),
      fields: CAPABILITY_FIELDS.filter((f) => f.kind === "bool" && !f.key.startsWith("reasoning")),
    },
    {
      title: t("web.settings.model_capabilities.group.reasoning"),
      fields: CAPABILITY_FIELDS.filter((f) => f.key.startsWith("reasoning")),
    },
  ];

  for (const group of groups) {
    const section = el("div", "caps-group");
    section.appendChild(el("div", "sec-title", group.title));
    for (const field of group.fields) {
      const label = t("config.field." + field.key);
      const row = el("div", "row");
      row.appendChild(el("span", "row-name", label));
      if (field.kind === "bool") {
        const on = current[field.key] === true;
        const sw = makeToggle(on, (next) => {
          form[field.key] = next;
          return true;
        });
        sw.setAttribute("aria-label", `${model}: ${label}`);
        form[field.key] = on;
        row.appendChild(sw);
      } else if (field.kind === "enum") {
        const sel = el("select", "val");
        const none = el("option", "", t("config.enum.none"));
        none.value = "";
        sel.appendChild(none);
        for (const option of field.options ?? []) {
          const op = el("option", "", option);
          op.value = option;
          sel.appendChild(op);
        }
        sel.value = typeof current[field.key] === "string" ? String(current[field.key]) : "";
        sel.setAttribute("aria-label", `${model}: ${label}`);
        sel.addEventListener("change", () => { form[field.key] = sel.value; });
        form[field.key] = sel.value;
        row.appendChild(sel);
      } else {
        const initial = Array.isArray(current[field.key])
          ? current[field.key].map(String)
          : [];
        row.appendChild(reasoningLevelsField(model, field.key, label, initial, form));
      }
      section.appendChild(row);
    }
    body.appendChild(section);
  }

  const actions = el("div", "model-pane-actions");
  const save = el("button", "btn", t("web.settings.save"));
  save.type = "button";
  save.addEventListener("click", () => {
    void postConfig("modelCapabilities", buildModelCapabilities(all, model, form), true).then(
      (ok) => { if (ok) closeSubDialog(); },
    );
  });
  const reset = el("button", "btn", t("web.settings.model_capabilities.reset"));
  reset.type = "button";
  reset.addEventListener("click", () => {
    void postConfig("modelCapabilities", buildModelCapabilities(all, model, {}), true).then(
      (ok) => { if (ok) closeSubDialog(); },
    );
  });
  const cancel = el("button", "btn", t("web.settings.cancel"));
  cancel.type = "button";
  cancel.addEventListener("click", () => closeSubDialog());
  actions.append(save, reset, cancel);
  body.appendChild(actions);

  openSubDialog(t("web.settings.model_capabilities.title", { model }), body);
}
