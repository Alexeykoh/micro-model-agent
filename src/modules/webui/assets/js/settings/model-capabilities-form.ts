// Per-model capability editor: one popup form over config.modelCapabilities[model].
// Fields mirror ModelCapabilities (src/config/types.ts); labels come from the
// same config.field.* keys as the Capabilities table.
import { el } from "../dom.js";
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

  for (const field of CAPABILITY_FIELDS) {
    const label = t("config.field." + field.key);
    const row = el("label", "table-field");
    row.appendChild(el("span", "table-field-label", label));
    let input: HTMLInputElement | HTMLSelectElement;
    if (field.kind === "bool") {
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = current[field.key] === true;
      input = cb;
    } else if (field.kind === "enum") {
      const sel = el("select");
      const none = el("option", "", t("config.enum.none"));
      none.value = "";
      sel.appendChild(none);
      for (const option of field.options ?? []) {
        const op = el("option", "", option);
        op.value = option;
        sel.appendChild(op);
      }
      sel.value = typeof current[field.key] === "string" ? String(current[field.key]) : "";
      input = sel;
    } else {
      const text = el("input");
      text.type = "text";
      text.placeholder = "low, medium, xhigh";
      text.value = Array.isArray(current[field.key])
        ? current[field.key].join(", ")
        : current[field.key] == null
          ? ""
          : String(current[field.key]);
      input = text;
    }
    input.setAttribute("aria-label", `${model}: ${label}`);
    form[field.key] =
      field.kind === "bool" ? current[field.key] === true : input.value;
    input.addEventListener("change", () => {
      form[field.key] = field.kind === "bool"
        ? (input as HTMLInputElement).checked
        : input.value;
    });
    row.appendChild(input);
    body.appendChild(row);
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
