// MCP add/edit form (nested dialog). Extracted from `panels.ts` so the panel
// stays under its size ceiling and the form owns its own validation/error state.
//
// UX contract (B-37): validation errors render inside the form next to Save
// (aria-live), `command`/`url` are shown per transport, and transport is a real
// choice with no empty option. The layout is a two-column grid: identity and
// transport on the first row, the transport-specific endpoint full-width, and
// JSON maps in a wide, readable "additional" block.
import { el, link } from "../dom.js";
import { api } from "../api.js";
import { t } from "../i18n.js";
import { settings } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { setIndicator } from "../dialog.js";
import { closeSubDialog } from "./subdialog.js";
import { mcpLiteralField, providerInput, providerSelect, providerCheck } from "./form.js";

/** Transports accepted by the server (`MCP_TRANSPORTS` in settings-api). */
const TRANSPORTS = ["stdio", "sse", "http"] as const;

interface McpFields {
  name: HTMLInputElement;
  transport: HTMLSelectElement;
  command: HTMLInputElement;
  url: HTMLInputElement;
  args: HTMLTextAreaElement;
  timeout: HTMLInputElement;
  env: HTMLTextAreaElement;
  headers: HTMLTextAreaElement;
  enabled: HTMLInputElement;
}

/** Read an MCP field's trimmed value. */
function val(input: HTMLInputElement | HTMLTextAreaElement): string {
  return input.value.trim();
}

/** Inline form error writer (cleared on the next edit). */
function errorWriter(box: HTMLElement): (msg: string) => void {
  const node = el("div", "pform-error");
  node.setAttribute("role", "alert");
  node.setAttribute("aria-live", "polite");
  node.hidden = true;
  box.appendChild(node);
  return (msg: string) => {
    node.textContent = msg;
    node.hidden = false;
  };
}

/** Multi-line JSON editor: monospace, no spellcheck, room for one object. */
function jsonArea(value: string, placeholder: string): HTMLTextAreaElement {
  const area = el("textarea");
  area.className = "pform-json";
  area.rows = 3;
  area.spellcheck = false;
  area.value = value;
  area.placeholder = placeholder;
  return area;
}

/** Checkbox row: label + optional hint on the right, control on the left. */
function toggleField(label: string, input: HTMLInputElement, hint: string): HTMLElement {
  const row = el("label", "pform-toggle pform-wide");
  row.appendChild(input);
  const body = el("span", "pform-toggle-body");
  body.appendChild(el("span", "pform-toggle-label", label));
  if (hint) body.appendChild(el("span", "pform-hint", hint));
  row.appendChild(body);
  input.setAttribute("aria-label", label);
  return row;
}

/** Inline MCP add/edit form body, rendered inside the nested dialog. */
export function mcpForm(): HTMLElement {
  const mode = (settings.mcpForm && settings.mcpForm.mode) || "add";
  const editing: Dict = (settings.mcpForm && settings.mcpForm.entry) || {};
  const box = el("div", "pform pform-mcp");
  const grid = el("div", "pform-grid pform-grid-2");
  const f: McpFields = {
    name: providerInput(editing.name || "", "text", "my-server"),
    transport: providerSelect([...TRANSPORTS], editing.transport || "stdio", false),
    command: providerInput(editing.command || "", "text", "npx"),
    url: providerInput(editing.url || "", "text", "https://…"),
    args: jsonArea(editing.args ? JSON.stringify(editing.args) : "", '["--stdio"]'),
    timeout: providerInput(
      editing.timeout != null ? String(editing.timeout) : "",
      "number",
      "30000",
    ),
    env: jsonArea("", '{"TOKEN": "…"}'),
    headers: jsonArea("", '{"Authorization": "…"}'),
    enabled: providerCheck(editing.enabled !== false),
  };
  const nameField = mcpLiteralField(t("web.settings.mcp_field_name"), f.name, "name", {
    hint: t("web.settings.mcp_hint_name"),
  });
  const transportField = mcpLiteralField(
    t("web.settings.mcp_field_transport"),
    f.transport,
    "transport",
    { hint: t("web.settings.mcp_hint_transport") },
  );
  const commandField = mcpLiteralField(t("web.settings.mcp_field_command"), f.command, "command", {
    wide: true,
    hint: t("web.settings.mcp_hint_command"),
  });
  const urlField = mcpLiteralField(t("web.settings.mcp_field_url"), f.url, "url", {
    wide: true,
    hint: t("web.settings.mcp_hint_url"),
  });
  grid.appendChild(nameField);
  grid.appendChild(transportField);
  grid.appendChild(commandField);
  grid.appendChild(urlField);
  box.appendChild(grid);

  const adv = el("details", "pform-adv");
  adv.open = true;
  adv.appendChild(el("summary", "", t("web.settings.provider_advanced")));
  const advGrid = el("div", "pform-grid pform-grid-2");
  const envKeys = Array.isArray(editing.envKeys) ? editing.envKeys : [];
  const headerKeys = Array.isArray(editing.headerKeys) ? editing.headerKeys : [];
  f.env.placeholder = envKeys.length
    ? "stored: " + envKeys.join(", ") + " — blank keeps"
    : '{"TOKEN": "…"}';
  f.headers.placeholder = headerKeys.length
    ? "stored: " + headerKeys.join(", ") + " — blank keeps"
    : '{"Authorization": "…"}';
  advGrid.appendChild(
    mcpLiteralField(t("web.settings.mcp_field_args"), f.args, "args", {
      wide: true,
      hint: t("web.settings.mcp_hint_args"),
    }),
  );
  advGrid.appendChild(
    mcpLiteralField(t("web.settings.mcp_field_timeout"), f.timeout, "timeout", {
      hint: t("web.settings.mcp_hint_timeout"),
    }),
  );
  advGrid.appendChild(
    mcpLiteralField(t("web.settings.mcp_field_env"), f.env, "env", {
      wide: true,
      hint: t("web.settings.mcp_hint_env"),
    }),
  );
  advGrid.appendChild(
    mcpLiteralField(t("web.settings.mcp_field_headers"), f.headers, "headers", {
      wide: true,
      hint: t("web.settings.mcp_hint_headers"),
    }),
  );
  advGrid.appendChild(
    toggleField(t("web.settings.mcp_field_enabled"), f.enabled, t("web.settings.mcp_hint_enabled")),
  );
  adv.appendChild(advGrid);
  box.appendChild(adv);

  // Only the field that transport actually uses is visible; advanced fields
  // stay where they are (`<details>`). No empty transport exists in the select.
  const syncTransport = (): void => {
    const stdio = f.transport.value === "stdio";
    commandField.hidden = !stdio;
    urlField.hidden = stdio;
  };
  f.transport.addEventListener("change", syncTransport);
  syncTransport();

  const showError = errorWriter(box);
  const clearError = (): void => {
    const node = box.querySelector<HTMLElement>(".pform-error");
    if (node) {
      node.hidden = true;
      node.textContent = "";
    }
  };
  box.addEventListener("input", clearError);
  box.addEventListener("change", clearError);

  const actions = el("div", "pform-actions");
  actions.appendChild(
    link(t("web.settings.save"), "", () => void submitMcpForm(f, mode, editing, showError)),
  );
  actions.appendChild(link(t("web.settings.cancel"), "dim", () => closeSubDialog()));
  box.appendChild(actions);
  return box;
}

function parseJsonMap(raw: string): { present: boolean; value: Dict | null } {
  const text = raw.trim();
  if (!text) return { present: false, value: null };
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { present: true, value: null };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { present: true, value: null };
  }
  if (!Object.values(parsed).every((v) => typeof v === "string")) {
    return { present: true, value: null };
  }
  return { present: true, value: parsed as Dict };
}

async function submitMcpForm(
  f: McpFields,
  mode: string,
  editing: Dict,
  showError: (msg: string) => void,
): Promise<void> {
  const name = val(f.name);
  const transport = f.transport.value;
  // Never send an empty transport. The select has no empty option, but a
  // hand-edited/legacy DOM value must be rejected explicitly, not guessed.
  if (!(TRANSPORTS as readonly string[]).includes(transport)) {
    showError(t("web.settings.mcp_transport_required"));
    return;
  }
  const command = val(f.command);
  const url = val(f.url);
  if (!name || (transport === "stdio" ? !command : !url)) {
    showError(t("web.settings.mcp_required"));
    return;
  }
  const body: Dict = { name, transport };
  if (transport === "stdio") body.command = command;
  else body.url = url;
  const argsRaw = val(f.args);
  if (argsRaw) {
    let args: unknown = null;
    try {
      args = JSON.parse(argsRaw);
    } catch {
      args = null;
    }
    if (!Array.isArray(args) || !args.every((x) => typeof x === "string")) {
      showError(t("web.settings.mcp_invalid"));
      return;
    }
    body.args = args;
  }
  for (const key of ["env", "headers"] as const) {
    const parsed = parseJsonMap(f[key].value);
    if (parsed.present && !parsed.value) {
      showError(t("web.settings.mcp_invalid"));
      return;
    }
    if (parsed.present) body[key] = parsed.value;
  }
  const timeoutRaw = val(f.timeout);
  if (timeoutRaw) {
    const n = Number(timeoutRaw);
    if (!Number.isInteger(n) || n < 1000 || n > 300000) {
      showError(t("web.settings.mcp_invalid"));
      return;
    }
    body.timeout = n;
  }
  body.enabled = f.enabled.checked;
  const target =
    mode === "edit" ? "/api/mcp/" + encodeURIComponent(editing.id || editing.name) : "/api/mcp";
  const r = await api<Dict>(target, { method: mode === "edit" ? "PUT" : "POST", body });
  if (r.ok && r.data && r.data.ok) {
    setIndicator(t("web.settings.mcp_saved"), false);
    closeSubDialog();
  } else {
    showError((r.data && String(r.data.error)) || t("web.settings.save_failed"));
  }
}
