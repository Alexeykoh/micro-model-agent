// Small form primitives shared by the provider form and the MCP/LSP dialogs
// (settings/providers.js + settings/panels.js). Leaf module.
import { el } from "../dom.js";
import { t } from "../i18n.js";

/** Labelled field wrapper (label above control). */
export function pfield(labelKey, input) {
  const f = el("div", "pform-field");
  f.appendChild(el("label", "", t(labelKey)));
  input.setAttribute("aria-label", t(labelKey));
  f.appendChild(input);
  return f;
}

/** Plain text/number/password input with optional placeholder. */
export function providerInput(value, type, placeholder) {
  const input = el("input");
  input.type = type || "text";
  if (placeholder) input.placeholder = placeholder;
  if (value != null) input.value = String(value);
  return input;
}

/** `<select>` with a leading "—" option; keeps unknown stored values selectable. */
export function providerSelect(options, value) {
  const sel = el("select");
  const none = el("option", "", "—");
  none.value = "";
  sel.appendChild(none);
  const seen = new Set([""]);
  options.forEach((v) => {
    seen.add(v);
    const o = el("option", "", v);
    o.value = v;
    if (v === value) o.selected = true;
    sel.appendChild(o);
  });
  // Keep a stored-but-unknown value selectable (e.g. a legacy provider type
  // from hand-edited config) instead of silently resetting it to "—".
  if (value != null && value !== "" && !seen.has(value)) {
    const o = el("option", "", value);
    o.value = value;
    o.selected = true;
    sel.appendChild(o);
  }
  if (value == null) sel.value = "";
  return sel;
}

/** Checkbox reflecting a boolean config value. */
export function providerCheck(value) {
  const input = el("input");
  input.type = "checkbox";
  input.checked = value === true;
  return input;
}

/** Labelled field whose label is a literal string (not an i18n key). */
export function mcpLiteralField(label, input) {
  const f = el("div", "pform-field");
  const lab = el("label", "", label);
  f.appendChild(lab);
  input.setAttribute("aria-label", label);
  f.appendChild(input);
  return f;
}
